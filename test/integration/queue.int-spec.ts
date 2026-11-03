import type { INestApplicationContext } from '@nestjs/common';
import { getQueueToken } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { BSON, Db, Document, MongoClient, MongoNetworkError, ObjectId } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import pino from 'pino';
import { DomainRecord, Run, TARGET_WRITER, TargetWriter, TERMINAL_RUN_STATUSES, WriteResult } from '../../src/core';
import { RUN_BATCHES, QUARANTINE } from '../../src/domain/run-metadata/run-metadata.indexes';
import { TARGET_DB } from '../../src/infra/mongo/mongo.tokens';
import { RAW_SOURCES } from '../../src/infra/seed/raw-sources';
import { DEFAULT_SEED_OPTIONS, seedRaw } from '../../src/infra/seed/seed-raw';
import { BatchProcessor } from '../../src/queue/batch.processor';
import { BATCH_QUEUE_NAME, batchJobId, DEAD_LETTER_QUEUE_NAME, DISPATCH_QUEUE_NAME } from '../../src/queue/queue.constants';
import { QueueProducer } from '../../src/queue/queue.producer';
import { RunsService } from '../../src/runs/runs.service';
import { connectTestClient } from '../support/mongo';
import { startRedis, TestRedis } from '../support/redis';
import { bootWorker } from '../support/nest';

const ROOT = resolve(__dirname, '../..');
const RAW_DB = 'provider_raw_queue_test';
const LOCATIONS = 'xbyte_raw_locations';
const RESTAURANTS = 'xbyte_raw_restaurants';
const MENUS = 'xbyte_raw_menus';

/** Expected coverage edges, computed straight from the raw file (not through the code under test). */
function uniqueOutletAreaPairs(): number {
  const docs = BSON.EJSON.parse(readFileSync(resolve(ROOT, 'data/raw/xbyte-raw-restaurants.json'), 'utf8')) as Document[];
  const pairs = new Set<string>();
  for (const d of docs) for (const r of d.payload.results ?? []) pairs.add(`${/\/restaurant\/(\d+)\//.exec(r.restaurant_url)![1]}|${d.params.areaId}`);
  return pairs.size;
}

describe('queue: dispatcher, batch workers, retries, dead letters (integration)', () => {
  let mongod: MongoMemoryServer;
  let redis: TestRedis;
  let redisUrl: string;
  let seedClient: MongoClient;
  let app: INestApplicationContext | undefined;

  beforeAll(async () => {
    [mongod, redis] = await Promise.all([MongoMemoryServer.create(), startRedis()]);
    redisUrl = redis.url;
    seedClient = await connectTestClient(mongod.getUri());
    await seedRaw(seedClient.db(RAW_DB), pino({ level: 'silent' }), RAW_SOURCES, { ...DEFAULT_SEED_OPTIONS, baseDir: ROOT });
  });
  beforeEach(() => redis.flush());
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });
  afterAll(async () => {
    await seedClient?.close();
    await Promise.all([mongod?.stop(), redis?.stop()]);
  });

  const start = async (env: Record<string, string> = {}, overrides?: Parameters<typeof bootWorker>[2]['overrides']) => {
    app = await bootWorker(mongod.getUri(), `target_${new ObjectId().toHexString()}`, {
      redisUrl,
      env: { RAW_DB_NAME: RAW_DB, WORKER_CONCURRENCY: '4', JOB_ATTEMPTS: '3', JOB_BACKOFF_MS: '200', ...env },
      overrides,
    });
    return { runs: app.get(RunsService), db: app.get<Db>(TARGET_DB, { strict: false }) };
  };

  const waitForTerminal = async (runs: RunsService, runId: string, timeoutMs = 90_000): Promise<Run> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const run = await runs.getRun(runId);
      if (run && TERMINAL_RUN_STATUSES.includes(run.status)) return run;
      if (Date.now() > deadline) throw new Error(`run ${runId} still ${run?.status} after ${timeoutMs} ms: ${JSON.stringify(run?.sources)}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  };

  it('a run over the seeded data completes with the expected counters and target counts', async () => {
    const { runs, db } = await start();
    const run = await waitForTerminal(runs, (await runs.start()).runId);

    // 155 "not restaurant page" menus + 2 listing error pages are quarantined, so failed > 0.
    expect(run.status).toBe('completed_with_errors');
    expect(run.counters).toMatchObject({ read: 578, failed: 157, skipped: 0, stale: 0 });
    expect(run.counters.written + run.counters.unchanged + run.counters.stale).toBe(run.counters.transformed);
    expect(run.sources).toMatchObject({
      [LOCATIONS]: { batchesTotal: 1, batchesDone: 1, batchesDead: 0, dispatchDone: true, dispatchedDocs: 8 },
      [RESTAURANTS]: { batchesTotal: 1, batchesDone: 1, batchesDead: 0, dispatchDone: true, dispatchedDocs: 70 },
      [MENUS]: { batchesTotal: 20, batchesDone: 20, batchesDead: 0, dispatchDone: true, dispatchedDocs: 500 }, // 500 / BATCH_SIZE_MENUS 25
    });
    expect(run.timings.finishedAt).toBeInstanceOf(Date);

    const failedBy = await db
      .collection(QUARANTINE)
      .aggregate([{ $match: { runId: run.runId, severity: 'error' } }, { $group: { _id: { c: '$rawCollection', r: '$reason' }, n: { $sum: 1 } } }])
      .toArray();
    expect(failedBy.map((x) => [x._id.c, x._id.r, x.n]).sort()).toEqual([
      [MENUS, 'PROVIDER_ERROR', 155],
      [RESTAURANTS, 'PROVIDER_ERROR', 2],
    ]);

    const count = (c: string) => db.collection(c).countDocuments();
    expect(await count('areas')).toBe(697);
    expect(await count('restaurants')).toBeGreaterThanOrEqual(302 + 345);
    expect(await count('restaurant_areas')).toBe(uniqueOutletAreaPairs());
    expect(await count('menu_items')).toBe(28773);

    // Batch jobs carry ranges, never documents.
    const batchQueue = app!.get<Queue>(getQueueToken(BATCH_QUEUE_NAME));
    const [job] = await batchQueue.getJobs(['completed'], 0, 0);
    expect(Object.keys(job.data).sort()).toEqual(['batchKey', 'fromId', 'rawCollection', 'runId', 'toId']);
    expect(job.id).toMatch(/^batch__[0-9a-f-]+__xbyte_raw_\w+__[0-9a-f]{24}__[0-9a-f]{24}$/);

    // A second run over the same data changes nothing.
    const second = await waitForTerminal(runs, (await runs.start()).runId);
    expect(second.counters).toMatchObject({ read: 578, written: 0, unchanged: run.counters.transformed, stale: 0 });
  });

  it('a forced Mongo failure retries with exponential backoff, dead-letters after JOB_ATTEMPTS, run ends completed_with_errors', async () => {
    const attempts: number[] = [];
    const failingWriter: TargetWriter = {
      upsert: async (_records: readonly DomainRecord[]): Promise<WriteResult> => {
        attempts.push(Date.now());
        throw new MongoNetworkError('connection reset by peer (test double)');
      },
    };
    // 500 ms base: BullMQ adds ~100-200 ms of scheduling latency per delayed retry, which would blur a smaller base.
    const { runs, db } = await start({ JOB_BACKOFF_MS: '500' }, [{ token: TARGET_WRITER, useValue: failingWriter }]);
    const run = await waitForTerminal(runs, (await runs.start({ collections: [LOCATIONS] })).runId);

    expect(attempts).toHaveLength(3); // JOB_ATTEMPTS
    const [gap1, gap2] = [attempts[1] - attempts[0], attempts[2] - attempts[1]];
    expect(gap1).toBeGreaterThanOrEqual(490); // JOB_BACKOFF_MS * 2^0
    expect(gap2).toBeGreaterThanOrEqual(990); // JOB_BACKOFF_MS * 2^1
    expect(gap2 - gap1).toBeGreaterThanOrEqual(350); // exponential: a fixed backoff would give gap2 ≈ gap1

    expect(run.status).toBe('completed_with_errors');
    expect(run.sources[LOCATIONS]).toMatchObject({ batchesTotal: 1, batchesDone: 0, batchesDead: 1 });
    expect(run.lastError).toContain('connection reset');

    const batch = await db.collection(RUN_BATCHES).findOne({ runId: run.runId });
    expect(batch).toMatchObject({ status: 'dead', attempts: 3, lastError: expect.stringContaining('connection reset') });

    const dlq = app!.get<Queue>(getQueueToken(DEAD_LETTER_QUEUE_NAME));
    const dead = await dlq.getJobs(['waiting', 'delayed', 'completed', 'failed']);
    expect(dead).toHaveLength(1);
    expect(dead[0].data).toMatchObject({ runId: run.runId, batchKey: batch!.batchKey, error: expect.stringContaining('connection reset'), stack: expect.any(String) });
  });

  it('reads WORKER_CONCURRENCY and batch sizes from validated config; filters cap collections and docs', async () => {
    const { runs } = await start({ WORKER_CONCURRENCY: '3', BATCH_SIZE_DEFAULT: '50', BATCH_SIZE_MENUS: '10' });
    expect(app!.get(BatchProcessor).worker.concurrency).toBe(3);

    const started = await runs.start({ collections: [RESTAURANTS, MENUS], limit: 35 });
    expect(started.config).toEqual({ batchSizes: { [RESTAURANTS]: 50, [MENUS]: 10 }, concurrency: 3, attempts: 3 });
    const run = await waitForTerminal(runs, started.runId);
    expect(Object.keys(run.sources).sort()).toEqual([MENUS, RESTAURANTS]);
    expect(run.sources[RESTAURANTS]).toMatchObject({ dispatchedDocs: 35, batchesTotal: 1 }); // limit 35 < batch 50
    expect(run.sources[MENUS]).toMatchObject({ dispatchedDocs: 35, batchesTotal: 4 }); // 10 + 10 + 10 + 5
    expect(run.counters.read).toBe(70);
    await expect(runs.start({ collections: ['nope'] })).rejects.toThrow(/unknown collection\(s\): nope/);
  });

  it('deterministic job ids: re-dispatching and re-enqueueing never double-enqueue', async () => {
    const { runs } = await start();
    const run = await waitForTerminal(runs, (await runs.start({ collections: [LOCATIONS] })).runId);
    const producer = app!.get(QueueProducer);
    const dispatchQueue = app!.get<Queue>(getQueueToken(DISPATCH_QUEUE_NAME));
    const batchQueue = app!.get<Queue>(getQueueToken(BATCH_QUEUE_NAME));
    const totals = async () => [await dispatchQueue.count(), (await dispatchQueue.getJobCounts('completed')).completed, (await batchQueue.getJobCounts('completed')).completed];
    const before = await totals();

    await producer.enqueueDispatch(run.runId, LOCATIONS);
    const batchKey = Object.keys(run.sources).length && (await batchQueue.getJobs(['completed']))[0].data.batchKey;
    await producer.enqueueBatches([{ runId: run.runId, rawCollection: LOCATIONS, fromId: 'x', toId: 'y', batchKey }]);
    expect(await batchQueue.getJob(batchJobId(run.runId, batchKey))).toBeDefined();
    expect(await totals()).toEqual(before);
  });
});
