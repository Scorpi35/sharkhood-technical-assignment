/**
 * The two properties the assignment tests explicitly:
 *  1. running twice yields the same target state (fingerprints), the second run writing nothing;
 *  2. losing a worker / Redis mid-run recovers without reprocessing completed work or corrupting output.
 */
import type { INestApplicationContext } from '@nestjs/common';
import { resolve } from 'node:path';
import { Db, Document, MongoClient, ObjectId } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import pino from 'pino';
import { DomainRecord, Run, TARGET_WRITER, TargetWriter, TERMINAL_RUN_STATUSES } from '../../src/core';
import { AREA_REPOSITORY } from '../../src/domain/area/area.repository';
import { CompositeTargetWriter } from '../../src/domain/composite-target-writer';
import { CollectionFingerprint, fingerprintTarget } from '../../src/domain/fingerprint/target-fingerprint';
import { MENU_ITEM_REPOSITORY } from '../../src/domain/menu-item/menu-item.repository';
import { MENU_REPOSITORY } from '../../src/domain/menu/menu.repository';
import { RESTAURANT_AREA_REPOSITORY } from '../../src/domain/restaurant-area/restaurant-area.repository';
import { RESTAURANT_REPOSITORY } from '../../src/domain/restaurant/restaurant.repository';
import { RUN_BATCHES } from '../../src/domain/run-metadata/run-metadata.indexes';
import { TARGET_DB } from '../../src/infra/mongo/mongo.tokens';
import { RAW_SOURCES } from '../../src/infra/seed/raw-sources';
import { DEFAULT_SEED_OPTIONS, seedRaw } from '../../src/infra/seed/seed-raw';
import { RunResumer } from '../../src/queue/run-resumer.service';
import { RunAlreadyFinishedError } from '../../src/runs/runs.errors';
import { RunsService } from '../../src/runs/runs.service';
import { connectTestClient } from '../support/mongo';
import { startRedis, TestRedis } from '../support/redis';
import { bootProducer, bootWorker } from '../support/nest';

const ROOT = resolve(__dirname, '../..');
const RAW_DB = 'provider_raw_resume_test';
const TARGET_COLLECTIONS = ['areas', 'restaurants', 'restaurant_areas', 'menus', 'menu_items'];
type Fingerprint = Record<string, CollectionFingerprint>;

describe('idempotency and resumability (integration)', () => {
  let mongod: MongoMemoryServer;
  let redis: TestRedis;
  let redisUrl: string;
  let seedClient: MongoClient;
  let maxRawCreatedAt: Date;
  let clean: { fingerprint: Fingerprint; run: Run };
  const open: INestApplicationContext[] = [];

  const env = { RAW_DB_NAME: RAW_DB, WORKER_CONCURRENCY: '4', JOB_ATTEMPTS: '3', JOB_BACKOFF_MS: '100' };
  const dbName = () => `target_${new ObjectId().toHexString()}`;
  const track = (app: INestApplicationContext) => (open.push(app), app);
  const flushRedis = () => redis.flush();
  const waitForTerminal = async (runs: RunsService, runId: string, timeoutMs = 60_000): Promise<Run> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const run = await runs.getRun(runId);
      if (run && TERMINAL_RUN_STATUSES.includes(run.status)) return run;
      if (Date.now() > deadline) throw new Error(`run ${runId} still ${run?.status}: ${JSON.stringify(run?.sources)}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  };
  /** A full run in a fresh target database. */
  const cleanRun = async () => {
    const app = track(await bootWorker(mongod.getUri(), dbName(), { redisUrl, env }));
    const runs = app.get(RunsService);
    const run = await waitForTerminal(runs, (await runs.start()).runId);
    return { app, runs, run, db: app.get<Db>(TARGET_DB, { strict: false }) };
  };

  beforeAll(async () => {
    [mongod, redis] = await Promise.all([MongoMemoryServer.create(), startRedis()]);
    redisUrl = redis.url;
    seedClient = await connectTestClient(mongod.getUri());
    const raw = seedClient.db(RAW_DB);
    await seedRaw(raw, pino({ level: 'silent' }), RAW_SOURCES, { ...DEFAULT_SEED_OPTIONS, baseDir: ROOT });
    maxRawCreatedAt = (
      await Promise.all(RAW_SOURCES.map((s) => raw.collection(s.collection).find().sort({ createdAt: -1 }).limit(1).next()))
    ).reduce((max, d) => (d!.createdAt > max ? d!.createdAt : max), new Date(0));

    await flushRedis();
    const { app, run, db } = await cleanRun();
    clean = { run, fingerprint: await fingerprintTarget(db) };
    await app.close();
  });
  beforeEach(flushRedis);
  afterEach(async () => {
    while (open.length) await open.pop()!.close().catch(() => undefined);
  });
  afterAll(async () => {
    await seedClient?.close();
    await Promise.all([mongod?.stop(), redis?.stop()]);
  });

  it('two consecutive runs over the same raw data produce identical fingerprints; the second has written = 0', async () => {
    const { runs, run: first, db } = await cleanRun();
    const fp1 = await fingerprintTarget(db);
    const second = await waitForTerminal(runs, (await runs.start()).runId);
    const fp2 = await fingerprintTarget(db);

    expect(fp2).toEqual(fp1);
    expect(fp1).toEqual(clean.fingerprint); // and equal to a run in a different database
    expect(first.counters.written).toBe(first.counters.transformed);
    expect(second.counters).toMatchObject({ read: 578, written: 0, unchanged: first.counters.transformed, stale: 0 });
    expect(Object.values(fp1).map((c) => c.count)).toEqual([697, 647, 463, 345, 28773]);
  });

  it('target documents carry nothing run-specific: no run/job/batch ids, no wall-clock time', async () => {
    const { db } = await cleanRun();
    const forbidden = /^(runId|jobId|batchKey|attempts|updatedAt|createdAt)$/;
    const problems: string[] = [];
    const walk = (value: unknown, path: string, collection: string) => {
      if (value instanceof Date) {
        if (value > maxRawCreatedAt) problems.push(`${collection}.${path}: ${value.toISOString()} is later than any raw createdAt (wall clock?)`);
      } else if (Array.isArray(value)) value.forEach((v, i) => walk(v, `${path}[${i}]`, collection));
      else if (value && typeof value === 'object' && !(value instanceof ObjectId)) {
        for (const [k, v] of Object.entries(value as Document)) {
          if (forbidden.test(k)) problems.push(`${collection}.${path ? `${path}.` : ''}${k}`);
          walk(v, path ? `${path}.${k}` : k, collection);
        }
      }
    };
    for (const c of TARGET_COLLECTIONS) for await (const doc of db.collection(c).find({}, { projection: { _id: 0 } })) walk(doc, '', c);
    expect([...new Set(problems)].slice(0, 10)).toEqual([]);
  });

  it('Redis loses all state before any processing: resume on boot completes the run, same fingerprint as a clean run', async () => {
    const target = dbName();
    const producer = track(await bootProducer(mongod.getUri(), target, { redisUrl, env }));
    const { runId } = await producer.get(RunsService).start(); // dispatch jobs are in Redis, no worker yet
    await producer.close();
    open.pop();
    await flushRedis(); // Redis forgets everything

    const worker = track(await bootWorker(mongod.getUri(), target, { redisUrl, env })); // ResumeOnBoot re-enqueues dispatch
    const run = await waitForTerminal(worker.get(RunsService), runId);
    expect(run.counters).toEqual(clean.run.counters);
    expect(await fingerprintTarget(worker.get<Db>(TARGET_DB, { strict: false }))).toEqual(clean.fingerprint);
  });

  it('worker stops mid-run and Redis is wiped: only unsettled batches are re-run, completed batches are not reprocessed', async () => {
    const target = dbName();
    // Slow every batch down so the run is still in flight when the first worker stops.
    const slowWriter = {
      token: TARGET_WRITER,
      inject: [AREA_REPOSITORY, RESTAURANT_REPOSITORY, RESTAURANT_AREA_REPOSITORY, MENU_REPOSITORY, MENU_ITEM_REPOSITORY],
      useFactory: (...repos: ConstructorParameters<typeof CompositeTargetWriter>): TargetWriter => {
        const real = new CompositeTargetWriter(...repos);
        return { upsert: async (records: readonly DomainRecord[]) => (await new Promise((r) => setTimeout(r, 150)), real.upsert(records)) };
      },
    };
    const smallBatches = { ...env, WORKER_CONCURRENCY: '2', BATCH_SIZE_MENUS: '10' }; // 50 menu batches
    const first = track(await bootWorker(mongod.getUri(), target, { redisUrl, env: smallBatches, overrides: [slowWriter as never] }));
    const db = seedClient.db(target); // an observer connection that outlives both worker processes
    const { runId } = await first.get(RunsService).start();
    for (let i = 0; (await db.collection(RUN_BATCHES).countDocuments({ runId, status: 'completed' })) < 8; i++) {
      if (i > 600) throw new Error('run did not progress');
      await new Promise((r) => setTimeout(r, 50));
    }
    await first.close(); // the worker stops (in-flight batches finish)
    open.pop();
    await flushRedis(); // and Redis forgets the remaining jobs

    const settledBefore = new Map(
      (await db.collection(RUN_BATCHES).find({ runId, status: 'completed' }).toArray()).map((b) => [b.batchKey as string, b.attempts as number]),
    );
    const unsettledBefore = await db.collection(RUN_BATCHES).countDocuments({ runId, status: { $in: ['queued', 'active'] } });
    expect(unsettledBefore).toBeGreaterThan(0); // genuinely mid-run

    const second = track(await bootWorker(mongod.getUri(), target, { redisUrl, env: smallBatches })); // ResumeOnBoot
    const run = await waitForTerminal(second.get(RunsService), runId);

    // Completed batches were not reprocessed: still completed, attempts unchanged.
    const after = new Map((await db.collection(RUN_BATCHES).find({ runId }).toArray()).map((b) => [b.batchKey as string, b]));
    for (const [key, attempts] of settledBefore) expect(after.get(key)).toMatchObject({ status: 'completed', attempts });
    expect([...after.values()].every((b) => b.status === 'completed')).toBe(true);
    // Every raw doc counted exactly once, and the output equals a clean run's (different batch size, same state).
    expect(run.counters).toMatchObject({ read: 578, failed: 157, transformed: clean.run.counters.transformed });
    expect(await fingerprintTarget(db)).toEqual(clean.fingerprint);
  });

  it('resume never touches live jobs, re-enqueues missing ones, and reports a finished run as already terminal', async () => {
    const target = dbName();
    const producer = track(await bootProducer(mongod.getUri(), target, { redisUrl, env })); // api role: no workers
    const resumer = producer.get(RunResumer, { strict: false });
    const { runId } = await producer.get(RunsService).start({ collections: ['xbyte_raw_locations'] });

    // The dispatch job is waiting in Redis: live, so resume leaves it alone.
    expect(await resumer.resume(runId)).toMatchObject({ status: 'dispatching', terminal: false, dispatchRequeued: [], batchesRequeued: 0 });

    // Redis forgets it: resume re-enqueues it under the same deterministic id.
    await flushRedis();
    expect(await resumer.resume(runId)).toMatchObject({ dispatchRequeued: ['xbyte_raw_locations'], batchesRequeued: 0 });

    // A worker finishes the run; resuming a finished run is an error (the API maps it to 409).
    const worker = track(await bootWorker(mongod.getUri(), target, { redisUrl, env }));
    const run = await waitForTerminal(worker.get(RunsService), runId);
    await expect(resumer.resume(runId)).rejects.toEqual(new RunAlreadyFinishedError(runId, run.status));
  });
});
