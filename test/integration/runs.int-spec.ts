import type { INestApplicationContext } from '@nestjs/common';
import { Db, ObjectId } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { BATCH_REPOSITORY, BatchRepository, QuarantineEntry, RunConfig, RunCounters, SampledIssue, zeroCounters } from '../../src/core';
import { QUARANTINE } from '../../src/domain/run-metadata/run-metadata.indexes';
import { TARGET_DB } from '../../src/infra/mongo/mongo.tokens';
import { RunsService } from '../../src/runs/runs.service';
import { bootRuns, manualClock } from '../support/nest';

const SRC = 'xbyte_raw_menus';
const config: RunConfig = { batchSizes: { [SRC]: 25 }, concurrency: 4, attempts: 5 };
const counters = (over: Partial<RunCounters>): RunCounters => ({ ...zeroCounters(), ...over });
const ok = counters({ read: 25, transformed: 2000, written: 2000 });
const err = (sourceId: string, i = 0): SampledIssue => ({ reason: 'PROVIDER_ERROR', message: `error page ${i}`, severity: 'error', sourceId, rawCollection: SRC, batchKey: 'x' });

describe('runs module (integration)', () => {
  let mongod: MongoMemoryServer;
  let app: INestApplicationContext;
  let runs: RunsService;
  let db: Db;
  let clock: ReturnType<typeof manualClock>;

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
  });
  beforeEach(async () => {
    clock = manualClock();
    app = await bootRuns(mongod.getUri(), `t_${new ObjectId().toHexString()}`, { clock, env: { ERROR_SAMPLE_SIZE: '5' } });
    runs = app.get(RunsService);
    db = app.get<Db>(TARGET_DB, { strict: false });
  });
  afterEach(async () => app?.close());
  afterAll(async () => mongod?.stop());

  /** A dispatched run over one source with `n` batches; returns the run id and batch keys. */
  async function dispatchedRun(n: number, rawCollections = [SRC]) {
    const run = await runs.createRun({ rawCollections, config });
    await runs.startDispatch(run.runId);
    const keys: string[] = [];
    for (const c of rawCollections) {
      const ranges = Array.from({ length: n }, (_, i) => ({ fromId: `${c}-${i}-a`, toId: `${c}-${i}-z` }));
      keys.push(...(await runs.registerBatches(run.runId, c, ranges, { cursor: ranges.at(-1)?.toId ?? null, done: true })));
    }
    return { runId: run.runId, keys };
  }

  describe('exactly-once counters', () => {
    it('calling completeBatch twice for the same batch increments run counters once', async () => {
      const { runId, keys } = await dispatchedRun(2);
      await runs.finishDispatch(runId);

      expect((await runs.completeBatch(runId, keys[0], ok, [])).applied).toBe(true);
      expect((await runs.completeBatch(runId, keys[0], ok, [])).applied).toBe(false);

      const run = await runs.getRun(runId);
      expect(run?.counters).toEqual(ok);
      expect(run?.sources[SRC]).toMatchObject({ batchesTotal: 2, batchesDone: 1 });
      expect(run?.status).toBe('running');
    });

    it('concurrent duplicate completions of one batch apply exactly once', async () => {
      const { runId, keys } = await dispatchedRun(1);
      await runs.finishDispatch(runId);
      const results = await Promise.all(Array.from({ length: 10 }, () => runs.completeBatch(runId, keys[0], ok, [])));
      expect(results.filter((r) => r.applied)).toHaveLength(1);
      expect((await runs.getRun(runId))?.counters).toEqual(ok);
    });

    it('a crash between "batch completed" and "run incremented" still finalises with correct totals', async () => {
      const { runId, keys } = await dispatchedRun(2);
      await runs.finishDispatch(runId);
      await runs.completeBatch(runId, keys[0], ok, []);
      // Simulate the crash: the batch row is completed, the run was never incremented.
      const batches = app.get<BatchRepository>(BATCH_REPOSITORY, { strict: false });
      await batches.complete(runId, keys[1], counters({ read: 3, failed: 1 }), clock());
      expect((await runs.getRun(runId))?.counters.read).toBe(25); // live counters are behind

      // The job is retried: the batch is already settled, so nothing is applied, but finalisation runs.
      const retry = await runs.completeBatch(runId, keys[1], counters({ read: 3, failed: 1 }), []);
      expect(retry).toEqual({ applied: false, runStatus: 'completed_with_errors' });
      const run = await runs.getRun(runId);
      expect(run?.counters).toEqual(counters({ read: 28, transformed: 2000, written: 2000, failed: 1 }));
      expect(run?.sources[SRC]).toMatchObject({ batchesTotal: 2, batchesDone: 2, batchesDead: 0 });
    });

    it('re-registering the same ranges neither duplicates batches nor re-counts them', async () => {
      const run = await runs.createRun({ rawCollections: [SRC], config });
      const ranges = [{ fromId: 'a', toId: 'b' }, { fromId: 'c', toId: 'd' }];
      const first = await runs.registerBatches(run.runId, SRC, ranges, { cursor: 'd', done: false });
      const again = await runs.registerBatches(run.runId, SRC, ranges, { cursor: 'd', done: true });
      expect(again).toEqual(first);
      expect(first).toEqual([`${SRC}:a:b`, `${SRC}:c:d`]);
      expect((await runs.getRun(run.runId))?.sources[SRC]).toMatchObject({ batchesTotal: 2, dispatchDone: true, dispatchCursor: 'd' });
    });

    it('batchStarted counts attempts and skips settled batches', async () => {
      const { runId, keys } = await dispatchedRun(1);
      expect(await runs.batchStarted(runId, keys[0])).toBe(1);
      await runs.batchAttemptFailed(runId, keys[0], 'boom');
      expect(await runs.batchStarted(runId, keys[0])).toBe(2);
      await runs.completeBatch(runId, keys[0], ok, []);
      expect(await runs.batchStarted(runId, keys[0])).toBeNull();
    });

    it('rejects completion of a batch that was never registered', async () => {
      const { runId } = await dispatchedRun(1);
      await expect(runs.completeBatch(runId, `${SRC}:nope:nope`, ok, [])).rejects.toThrow(/unknown batch/);
    });
  });

  describe('finalisation', () => {
    it('finalises to completed when nothing failed and no batch is dead', async () => {
      const { runId, keys } = await dispatchedRun(2);
      await runs.finishDispatch(runId);
      clock.advance(1500);
      await runs.completeBatch(runId, keys[0], ok, []);
      clock.advance(1500);
      const last = await runs.completeBatch(runId, keys[1], ok, []);
      expect(last.runStatus).toBe('completed');
      const run = await runs.getRun(runId);
      expect(run).toMatchObject({ status: 'completed', counters: counters({ read: 50, transformed: 4000, written: 4000 }) });
      expect(run?.timings.durationMs).toBe(3000);
      expect(run?.timings.finishedAt).toEqual(clock());
    });

    it('finalises to completed_with_errors when failed > 0', async () => {
      const { runId, keys } = await dispatchedRun(2);
      await runs.finishDispatch(runId);
      await runs.completeBatch(runId, keys[0], ok, []);
      expect((await runs.completeBatch(runId, keys[1], counters({ read: 25, failed: 3 }), [err('s1')])).runStatus).toBe('completed_with_errors');
    });

    it('finalises to completed_with_errors when a batch is dead (even with failed = 0)', async () => {
      const { runId, keys } = await dispatchedRun(2);
      await runs.finishDispatch(runId);
      await runs.completeBatch(runId, keys[0], ok, []);
      const dead = await runs.batchDead(runId, keys[1], 'attempts exhausted: ECONNRESET');
      expect(dead.runStatus).toBe('completed_with_errors');
      const run = await runs.getRun(runId);
      expect(run?.counters.failed).toBe(0);
      expect(run?.sources[SRC]).toMatchObject({ batchesDone: 1, batchesDead: 1 });
      expect(run?.lastError).toContain('ECONNRESET');
    });

    it('does not finalise before dispatch is done; finishDispatch finalises if every batch already settled', async () => {
      const { runId, keys } = await dispatchedRun(1);
      expect((await runs.completeBatch(runId, keys[0], ok, [])).runStatus).toBe('dispatching');
      expect(await runs.finishDispatch(runId)).toBe('completed');
    });

    it('a run with no batches completes on finishDispatch', async () => {
      const { runId } = await dispatchedRun(0);
      expect(await runs.finishDispatch(runId)).toBe('completed');
    });

    it('waits for every source', async () => {
      const { runId, keys } = await dispatchedRun(1, [SRC, 'xbyte_raw_locations']);
      await runs.finishDispatch(runId);
      expect((await runs.completeBatch(runId, keys[0], ok, [])).runStatus).toBe('running');
      expect((await runs.completeBatch(runId, keys[1], ok, [])).runStatus).toBe('completed');
    });

    it('failRun is terminal: later completions do not change the status', async () => {
      const { runId, keys } = await dispatchedRun(1);
      expect(await runs.failRun(runId, 'dispatcher crashed')).toBe(true);
      expect(await runs.failRun(runId, 'again')).toBe(false);
      expect((await runs.completeBatch(runId, keys[0], ok, [])).runStatus).toBe('failed');
      expect(await runs.getRun(runId)).toMatchObject({ status: 'failed', lastError: 'dispatcher crashed' });
    });

    it('keeps a capped error sample (the latest ERROR_SAMPLE_SIZE)', async () => {
      const { runId, keys } = await dispatchedRun(3);
      await runs.finishDispatch(runId);
      for (const [b, key] of keys.entries()) {
        await runs.completeBatch(runId, key, counters({ failed: 3 }), [0, 1, 2].map((i) => err(`b${b}`, i)));
      }
      const sample = (await runs.getRun(runId))?.errorSample ?? [];
      expect(sample).toHaveLength(5);
      expect(sample.map((s) => s.sourceId)).toEqual(['b1', 'b1', 'b2', 'b2', 'b2']); // the newest 5 of b0×3, b1×3, b2×3
    });
  });

  describe('quarantine', () => {
    const entry = (over: Partial<QuarantineEntry> = {}): QuarantineEntry => ({
      runId: 'run-1',
      batchKey: `${SRC}:a:z`,
      rawCollection: SRC,
      sourceId: '6a607b4ca08982f2261e393e',
      stage: 'validate',
      reason: 'PROVIDER_ERROR',
      message: 'provider returned an error page',
      path: 'payload.Message',
      severity: 'error',
      ...over,
    });

    it('quarantining the same issue twice gives one row (also across job ids and retries)', async () => {
      expect(await runs.quarantine([entry({ jobId: 'job-1' })])).toBe(1);
      expect(await runs.quarantine([entry({ jobId: 'job-2', message: 'retried' })])).toBe(0);
      expect(await db.collection(QUARANTINE).countDocuments({ runId: 'run-1' })).toBe(1);
      // the first occurrence is kept
      expect(await db.collection(QUARANTINE).findOne({ runId: 'run-1' })).toMatchObject({ jobId: 'job-1', message: 'provider returned an error page' });
    });

    it('treats a missing path as one identity, and different paths/sources/reasons as different rows', async () => {
      const { path: _omit, ...noPath } = entry();
      await runs.quarantine([noPath, noPath, entry(), entry({ path: 'payload.results[3]' }), entry({ sourceId: 'other' }), entry({ reason: 'EMPTY_PAYLOAD' })]);
      expect(await db.collection(QUARANTINE).countDocuments({ runId: 'run-1' })).toBe(5);
    });

    it('paginates by _id cursor and filters by reason', async () => {
      const entries = Array.from({ length: 25 }, (_, i) =>
        entry({ sourceId: `src-${String(i).padStart(2, '0')}`, reason: i % 5 === 0 ? 'SCHEMA_INVALID' : 'PROVIDER_ERROR' }),
      );
      await runs.quarantine(entries);

      const seen: string[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const page = await runs.listQuarantine('run-1', { cursor, limit: 10 });
        seen.push(...page.entries.map((e) => e.sourceId));
        cursor = page.nextCursor;
        pages += 1;
      } while (cursor);
      expect(pages).toBe(3);
      expect(seen).toHaveLength(25);
      expect(new Set(seen).size).toBe(25);

      const schema = await runs.listQuarantine('run-1', { limit: 100, reason: 'SCHEMA_INVALID' });
      expect(schema.entries.map((e) => e.sourceId)).toEqual(['src-00', 'src-05', 'src-10', 'src-15', 'src-20']);
      expect(schema.nextCursor).toBeUndefined();
      await expect(runs.listQuarantine('run-1', { cursor: 'not-an-id', limit: 10 })).rejects.toThrow(/invalid cursor/);
    });
  });
});
