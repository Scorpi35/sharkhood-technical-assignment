/**
 * The factory end to end: seed -> run -> verify, idempotency, and a worker crash.
 *
 * Real AppModule (APP_ROLE=all) over HTTP, Mongo (mongodb-memory-server), Redis
 * (testcontainers, or REDIS_URL). Batch size 3, so every collection spans several
 * batches processed concurrently. Seeded with the T06 fixtures plus real duplicate
 * snapshots: two more location snapshots and a re-fetch of the same listing page.
 */
// Must stay first: stall-recovery settings are read when the queue code is imported.
import { FAST_LOCK_DURATION_MS, FAST_STALLED_INTERVAL_MS } from '../support/fast-stall-recovery';
import type { INestApplication, INestApplicationContext } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { BSON, Document, MongoClient, ObjectId } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { DomainRecord, TARGET_WRITER, TargetWriter } from '../../src/core';
import { AppConfig } from '../../src/config/app-config';
import { parseEnv } from '../../src/config/env.schema';
import { AREA_REPOSITORY } from '../../src/domain/area/area.repository';
import { CompositeTargetWriter } from '../../src/domain/composite-target-writer';
import { CollectionFingerprint, fingerprintTarget } from '../../src/domain/fingerprint/target-fingerprint';
import { MENU_ITEM_REPOSITORY } from '../../src/domain/menu-item/menu-item.repository';
import { MENU_REPOSITORY } from '../../src/domain/menu/menu.repository';
import { RESTAURANT_AREA_REPOSITORY } from '../../src/domain/restaurant-area/restaurant-area.repository';
import { RESTAURANT_REPOSITORY } from '../../src/domain/restaurant/restaurant.repository';
import { QUARANTINE, RUN_BATCHES } from '../../src/domain/run-metadata/run-metadata.indexes';
import { MONGO_CLIENT } from '../../src/infra/mongo/mongo.tokens';
import { DEFAULT_SEED_OPTIONS, seedCollection } from '../../src/infra/seed/seed-raw';
import { BatchProcessor } from '../../src/queue/batch.processor';
import { DispatchProcessor } from '../../src/queue/dispatch.processor';
import { connectTestClient } from '../support/mongo';
import { bootWorker } from '../support/nest';
import { startRedis, TestRedis } from '../support/redis';

const ROOT = resolve(__dirname, '../..');
const RAW_DB = 'provider_raw_factory';
const TARGET_DB = `factory_${new ObjectId().toHexString()}`;
const LIVE_KEY = 'LEAKCHECK_7c1e9d4a';
const SEED: [file: string, collection: string][] = [
  ['test/fixtures/xbyte/locations.json', 'xbyte_raw_locations'],
  ['test/fixtures/xbyte/locations-snapshots.json', 'xbyte_raw_locations'],
  ['test/fixtures/xbyte/restaurants.json', 'xbyte_raw_restaurants'],
  ['test/fixtures/xbyte/restaurants-refetch.json', 'xbyte_raw_restaurants'],
  ['test/fixtures/xbyte/menus.json', 'xbyte_raw_menus'],
];
const TARGETS = ['areas', 'restaurants', 'restaurant_areas', 'menus', 'menu_items'];
const COLLISION_OUTLET = '34858'; // vendor 19770: "Picks for you" and "Bites" share category_id 2796833705

/** Expectations computed straight from the fixture files, not through the code under test. */
function expectedFromFixtures() {
  const load = (f: string) => BSON.EJSON.parse(readFileSync(resolve(ROOT, f), 'utf8')) as Document[];
  const [loc, locSnap, rest, restRefetch, menus] = SEED.map(([f]) => load(f));
  const listingRows = [...rest, ...restRefetch].flatMap((d) => (d.payload.results ?? []).map((r: Document) => ({ r, areaId: d.params.areaId })));
  const outletOf = (url: string) => /\/restaurant\/(\d+)\//.exec(url)![1];
  const goodMenus = menus.filter((d) => Array.isArray(d.payload.results)).map((d) => d.payload.results[0]);
  const isError = (d: Document) => 'Message' in d.payload || 'Page Error Message' in d.payload || ('error' in d.payload && !d.payload.results?.length);
  const collision = goodMenus.find((m) => String(m.outletCode) === COLLISION_OUTLET)!;
  const picksIds: string[] = [];
  for (const c of collision.category.filter((c: Document) => /^picks for you/i.test(c.category_name))) {
    for (const i of c.items) if (!picksIds.includes(String(i.item_id))) picksIds.push(String(i.item_id));
  }
  return {
    read: loc.length + locSnap.length + rest.length + restRefetch.length + menus.length,
    providerErrorIds: [...rest, ...restRefetch, ...menus].filter(isError).map((d) => (d._id as ObjectId).toHexString()).sort(),
    counts: {
      areas: new Set([...loc, ...locSnap].flatMap((d) => d.payload.results.map((r: Document) => r.location_id))).size,
      restaurants: new Set(listingRows.map(({ r }) => outletOf(r.restaurant_url))).size + goodMenus.length, // 0 listing/menu overlap
      restaurant_areas: new Set(listingRows.map(({ r, areaId }) => `${outletOf(r.restaurant_url)}|${areaId}`)).size,
      menus: goodMenus.length,
      menu_items: goodMenus.reduce((n, m) => n + new Set(m.category.flatMap((c: Document) => c.items.map((i: Document) => i.item_id))).size, 0),
    },
    collisionPicksIds: picksIds,
  };
}

describe('factory: seed -> run -> verify (integration)', () => {
  let mongod: MongoMemoryServer;
  let redis: TestRedis;
  let client: MongoClient;
  let app: INestApplication;
  let base: string;
  let firstRunFingerprint: Record<string, CollectionFingerprint>;
  const expected = expectedFromFixtures();
  const savedEnv = { ...process.env };
  const target = () => client.db(TARGET_DB);

  const http = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
  };
  const runToCompletion = async (timeoutMs = 30_000) => {
    const started = await http('POST', '/runs', {});
    expect(started.status).toBe(202);
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const { body } = await http('GET', `/runs/${started.body.runId}`);
      if (['completed', 'completed_with_errors', 'failed'].includes(body.status)) return body;
      if (Date.now() > deadline) throw new Error(`run ${started.body.runId} still ${body.status} after ${timeoutMs} ms`);
      await new Promise((r) => setTimeout(r, 100));
    }
  };

  beforeAll(async () => {
    [mongod, redis] = await Promise.all([MongoMemoryServer.create(), startRedis()]);
    await redis.flush();
    client = await connectTestClient(mongod.getUri());

    // Seed with the seed module's own functions, then give every raw doc a live-looking API key.
    for (const [file, collection] of SEED) await seedCollection(client.db(RAW_DB), { file, collection }, { ...DEFAULT_SEED_OPTIONS, baseDir: ROOT });
    for (const [, collection] of SEED) {
      await client.db(RAW_DB).collection(collection).updateMany({}, [
        { $set: { endpoint: `https://xb.example/api?api_key=${LIVE_KEY}`, 'payload.request_log.requests_url': `https://xb.example/api?api_key=${LIVE_KEY}&page=1` } },
      ]);
    }

    Object.assign(process.env, {
      NODE_ENV: 'test',
      APP_ROLE: 'all',
      MONGO_URI: mongod.getUri(),
      REDIS_URL: redis.url,
      RAW_DB_NAME: RAW_DB,
      TARGET_DB_NAME: TARGET_DB,
      BATCH_SIZE_DEFAULT: '3',
      BATCH_SIZE_MENUS: '3',
      WORKER_CONCURRENCY: '4',
      JOB_ATTEMPTS: '3',
      JOB_BACKOFF_MS: '100',
      LOG_LEVEL: 'silent',
    });
    const config = new AppConfig(parseEnv(process.env));
    const { AppModule } = await import('../../src/app.module'); // after env: config is validated at import
    const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRole(config)] })
      .overrideProvider(MONGO_CLIENT)
      .useFactory({ factory: () => connectTestClient(mongod.getUri()) })
      .compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.listen(0, '127.0.0.1');
    base = (await app.getUrl()).replace('[::1]', '127.0.0.1');
  });
  afterAll(async () => {
    await app?.close();
    await client?.close();
    await Promise.all([mongod?.stop(), redis?.stop()]);
    process.env = savedEnv;
  });

  it('test 1, full run: exact counters, target counts, the worst data cases, quarantine without the API key', async () => {
    const run = await runToCompletion();

    expect(run.status).toBe('completed_with_errors'); // provider error pages are real failures
    // Derived from the fixtures and batch size 3 (raw docs are batched in _id order):
    //   locations: 3 identical snapshots in one batch -> 15 records, 5 survive in-batch dedupe (10 deduplicated)
    //   listings:  page 0 and its re-fetch share a batch; 12 rows, 11 outlets -> the shared outlet's restaurant
    //              and coverage edge are deduplicated (2); the 2 error pages form the second batch
    //   menus:     3 good menus -> 3 restaurants + 3 menus + 11 + 22 + 3 items
    //   transformed = 5 + 11 + 11 + 3 + 3 + 36 = 69, all new on a fresh target, so written = 69
    expect(run.counters).toEqual({
      read: expected.read, // 11 raw docs: 3 location snapshots, 4 listing pages, 4 menus
      transformed: 69,
      written: 69,
      unchanged: 0,
      stale: 0,
      deduplicated: 12,
      skipped: 0,
      failed: expected.providerErrorIds.length, // 3: the "not restaurant page" menu, page-limit page, {"error":""} page
      warnings: 1, // outlet 708121: "Offers" and "Add On" share a category_id (merged)
    });
    expect(run.counters.written + run.counters.unchanged + run.counters.stale).toBe(run.counters.transformed);
    expect(run.sources).toMatchObject({
      xbyte_raw_locations: { batchesTotal: 1, batchesDone: 1 },
      xbyte_raw_restaurants: { batchesTotal: 2, batchesDone: 2 },
      xbyte_raw_menus: { batchesTotal: 2, batchesDone: 2 },
    });

    const counts = Object.fromEntries(await Promise.all(TARGETS.map(async (c) => [c, await target().collection(c).countDocuments()])));
    expect(counts).toEqual(expected.counts);

    // Worst case 1: "Picks for you" collides with "Bites" on category_id.
    const menu = await target().collection('menus').findOne({ platform: 'talabat', restaurantExternalId: COLLISION_OUTLET });
    expect(menu!.categories.map((c: Document) => c.name)).not.toContainEqual(expect.stringMatching(/picks for you/i));
    expect(menu!.categories.filter((c: Document) => c.name === 'Bites')).toHaveLength(1);
    expect(menu!.featuredItemIds).toEqual(expected.collisionPicksIds);

    // Worst case 2: float noise (18.9 * 100 = 1889.9999999999998) and a trailing space in the name.
    const item = await target().collection('menu_items').findOne({ platform: 'talabat', restaurantExternalId: '749293', itemId: '943105657' });
    expect(item).toMatchObject({ name: 'Foul Maslah', priceMinor: 1890, currency: 'AED', isFeatured: true, isAvailable: true });

    // Quarantine: exactly the provider error documents, with no trace of the API key anywhere.
    const errors = await target().collection(QUARANTINE).find({ runId: run.runId, reason: 'PROVIDER_ERROR' }).toArray();
    expect(errors.map((e) => e.sourceId).sort()).toEqual(expected.providerErrorIds);
    const everything = JSON.stringify([
      await target().collection(QUARANTINE).find({ runId: run.runId }).toArray(),
      run,
      ...(await Promise.all(TARGETS.map((c) => target().collection(c).find().toArray()))),
    ]);
    expect(everything).not.toContain(LIVE_KEY);

    firstRunFingerprint = await fingerprintTarget(target());
  });

  it('test 2, idempotency: a second run writes nothing and the fingerprint is unchanged', async () => {
    expect(firstRunFingerprint).toBeDefined();
    const run = await runToCompletion();
    expect(run.counters).toMatchObject({ read: expected.read, written: 0, stale: 0 });
    expect(run.counters.unchanged).toBe(run.counters.transformed);
    expect(await fingerprintTarget(target())).toEqual(firstRunFingerprint);
  });

  it('test 3, resumability: a worker dies after 2 batches, a fresh worker finishes, same fingerprint as test 1', async () => {
    expect(firstRunFingerprint).toBeDefined();
    for (const c of TARGETS) await target().collection(c).deleteMany({}); // fresh target (indexes kept)

    // Only the doomed worker may take jobs: pause the main app's workers.
    const mainWorkers = [app.get(BatchProcessor).worker, app.get(DispatchProcessor).worker];
    await Promise.all(mainWorkers.map((w) => w.pause()));

    // The doomed worker: after 2 successful batches, its 3rd write never returns and
    // its BullMQ workers are force-closed, like `kill -9`: locks stop being renewed.
    const doomed: { app?: INestApplicationContext } = {}; // bound after boot; the crashing writer reads it
    let writes = 0;
    let releaseHung: () => void = () => undefined;
    const crashing = {
      token: TARGET_WRITER,
      inject: [AREA_REPOSITORY, RESTAURANT_REPOSITORY, RESTAURANT_AREA_REPOSITORY, MENU_REPOSITORY, MENU_ITEM_REPOSITORY],
      useFactory: (...repos: ConstructorParameters<typeof CompositeTargetWriter>): TargetWriter => {
        const real = new CompositeTargetWriter(...repos);
        return {
          upsert: async (records: readonly DomainRecord[]) => {
            if (++writes <= 2) return real.upsert(records);
            await Promise.all([doomed.app!.get(BatchProcessor).worker.close(true), doomed.app!.get(DispatchProcessor).worker.close(true)]);
            await new Promise<void>((r) => (releaseHung = r)); // the "dead" process never answers
            throw new Error('process was killed');
          },
        };
      },
    };
    doomed.app = await bootWorker(mongod.getUri(), TARGET_DB, {
      redisUrl: redis.url,
      env: { RAW_DB_NAME: RAW_DB, BATCH_SIZE_DEFAULT: '3', BATCH_SIZE_MENUS: '3', WORKER_CONCURRENCY: '1', LOG_LEVEL: 'silent' },
      overrides: [crashing as never],
    });

    const { body: started } = await http('POST', '/runs', {});
    for (let i = 0; writes < 3; i++) {
      if (i > 300) throw new Error('the doomed worker never reached its 3rd batch');
      await new Promise((r) => setTimeout(r, 50));
    }
    const completedAtCrash = await target().collection(RUN_BATCHES).find({ runId: started.runId, status: 'completed' }).toArray();
    expect(completedAtCrash).toHaveLength(2);

    // A fresh worker: recovers the dead worker's active jobs once their locks expire (3 s + 1 s check).
    const crashedAt = Date.now();
    const fresh = await bootWorker(mongod.getUri(), TARGET_DB, {
      redisUrl: redis.url,
      env: { RAW_DB_NAME: RAW_DB, BATCH_SIZE_DEFAULT: '3', BATCH_SIZE_MENUS: '3', LOG_LEVEL: 'silent' },
    });
    try {
      let run: Record<string, any> = {}; // eslint-disable-line @typescript-eslint/no-explicit-any
      for (let i = 0; i < 200 && !['completed', 'completed_with_errors', 'failed'].includes(run.status); i++) {
        await new Promise((r) => setTimeout(r, 100));
        run = (await http('GET', `/runs/${started.runId}`)).body;
      }
      expect(run.status).toBe('completed_with_errors');
      expect(run.counters.read).toBe(expected.read); // every raw doc counted exactly once
      // Recovered by the stall checker with the fast settings, not the 30 s production default.
      expect(Date.now() - crashedAt).toBeLessThan(FAST_LOCK_DURATION_MS + FAST_STALLED_INTERVAL_MS + 5000);

      // Batches completed before the crash were not reprocessed; the in-flight one was re-run.
      const after = await target().collection(RUN_BATCHES).find({ runId: started.runId }).toArray();
      for (const b of completedAtCrash) expect(after.find((a) => a.batchKey === b.batchKey)).toMatchObject({ status: 'completed', attempts: 1 });
      expect(after.every((b) => b.status === 'completed')).toBe(true);
      expect(after.some((b) => b.attempts > 1)).toBe(true);

      expect(await fingerprintTarget(target())).toEqual(firstRunFingerprint);
    } finally {
      releaseHung();
      await fresh.close();
      await doomed.app.close().catch(() => undefined);
      await Promise.all(mainWorkers.map((w) => w.resume()));
    }
  });
});
