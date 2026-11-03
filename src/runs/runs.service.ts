import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  BATCH_REPOSITORY,
  batchKeyOf,
  BatchRepository,
  BatchStatus,
  BatchStatusCounts,
  CLOCK,
  Clock,
  DISPATCH_QUEUE,
  DispatchQueue,
  PROVIDER_REGISTRY,
  ProviderRegistry,
  QUARANTINE_REPOSITORY,
  QuarantineEntry,
  QuarantinePage,
  QuarantineQuery,
  QuarantineRepository,
  Run,
  RUN_REPOSITORY,
  RunConfig,
  RunCounters,
  RunRepository,
  RunSourceProgress,
  RunStatus,
  SampledIssue,
  TERMINAL_RUN_STATUSES,
  zeroCounters,
} from '../core';
import { AppConfig } from '../config/app-config';

export class UnknownBatchError extends Error {
  override readonly name = 'UnknownBatchError';
}

export interface BatchRange {
  readonly fromId: string;
  readonly toId: string;
}

/** What a run migrates. Validated by RunsService.start. */
export interface RunFilters {
  /** Raw collections to migrate; default: every registered one. */
  readonly collections?: readonly string[];
  /** Cap on raw documents per collection (first N by _id). */
  readonly limit?: number;
}

export class InvalidRunFiltersError extends Error {
  override readonly name = 'InvalidRunFiltersError';
}

export interface SettleResult {
  /** True only for the call that settled the batch (counters were applied by it). */
  readonly applied: boolean;
  /** The run status after this call (terminal if this call, or an earlier one, finalised it). */
  readonly runStatus: RunStatus;
}

const emptySource = (): RunSourceProgress => ({ dispatchCursor: null, dispatchedDocs: 0, dispatchDone: false, batchesTotal: 0, batchesDone: 0, batchesDead: 0 });

/**
 * Run lifecycle and bookkeeping: pending -> dispatching -> running ->
 * completed | completed_with_errors (or failed).
 *
 * Exactly-once counters: a batch's counters reach the run only through the call
 * that moves the batch to a settled status (a guarded findOneAndUpdate), so
 * retried or duplicated completions add nothing.
 *
 * Crash safety: batch and run are two documents, so a crash between "batch
 * completed" and "run incremented" is possible. The run's live counters are
 * then briefly behind, but finalisation never trusts them: it recomputes
 * counters and batch totals from run_batches. It is re-attempted on every
 * settle and on dispatch completion, so a retry still finalises the run.
 */
@Injectable()
export class RunsService {
  private readonly logger = new Logger(RunsService.name);

  constructor(
    @Inject(RUN_REPOSITORY) private readonly runs: RunRepository,
    @Inject(BATCH_REPOSITORY) private readonly batches: BatchRepository,
    @Inject(QUARANTINE_REPOSITORY) private readonly quarantineRepo: QuarantineRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(PROVIDER_REGISTRY) private readonly registry: ProviderRegistry,
    @Inject(DISPATCH_QUEUE) private readonly dispatchQueue: DispatchQueue,
    private readonly appConfig: AppConfig,
  ) {}

  /**
   * Create a run (pending), enqueue one dispatch job per selected source, and
   * move it to dispatching. Batch sizes, concurrency and attempts come from the
   * validated config (and each handler's batch size), recorded on the run.
   */
  async start(filters: RunFilters = {}): Promise<Run> {
    const rawCollections = filters.collections ?? this.registry.rawCollections();
    const unknown = rawCollections.filter((c) => !this.registry.has(c));
    if (rawCollections.length === 0 || unknown.length > 0) {
      throw new InvalidRunFiltersError(
        unknown.length > 0 ? `unknown raw collection(s): ${unknown.join(', ')} (known: ${this.registry.rawCollections().join(', ')})` : 'no raw collections selected',
      );
    }
    if (filters.limit !== undefined && !(Number.isInteger(filters.limit) && filters.limit > 0)) {
      throw new InvalidRunFiltersError(`limit must be a positive integer, got ${filters.limit}`);
    }
    const config: RunConfig = {
      batchSizes: Object.fromEntries(
        rawCollections.map((c) => [c, this.registry.resolve(c).handler.batchSize ?? this.appConfig.batch.defaultSize]),
      ),
      concurrency: this.appConfig.jobs.concurrency,
      attempts: this.appConfig.jobs.attempts,
    };
    const run = await this.createRun({
      rawCollections,
      config,
      filters: { collections: [...rawCollections], ...(filters.limit === undefined ? {} : { limit: filters.limit }) },
    });
    await this.startDispatch(run.runId);
    try {
      for (const c of rawCollections) await this.dispatchQueue.enqueueDispatch(run.runId, c);
    } catch (err) {
      await this.failRun(run.runId, `could not enqueue dispatch: ${(err as Error).message}`);
      throw err;
    }
    this.logger.log({ runId: run.runId, rawCollections, config }, 'Run started');
    return (await this.runs.get(run.runId)) ?? run;
  }

  // ---------------------------------------------------------------- lifecycle

  async createRun(input: { rawCollections: readonly string[]; config: RunConfig; filters?: Readonly<Record<string, unknown>> }): Promise<Run> {
    if (input.rawCollections.length === 0) throw new RangeError('a run needs at least one raw collection');
    const run: Run = {
      runId: randomUUID(),
      status: 'pending',
      filters: input.filters ?? {},
      config: input.config,
      sources: Object.fromEntries(input.rawCollections.map((c) => [c, emptySource()])),
      counters: zeroCounters(),
      timings: { createdAt: this.clock() },
      errorSample: [],
    };
    await this.runs.create(run);
    return run;
  }

  getRun(runId: string): Promise<Run | null> {
    return this.runs.get(runId);
  }

  async startDispatch(runId: string): Promise<boolean> {
    return this.runs.transition(runId, ['pending'], 'dispatching', { startedAt: this.clock() });
  }

  /**
   * Register the next ranges of one source. Idempotent: re-registering a range
   * (e.g. a dispatcher restart) neither duplicates the batch nor re-counts it.
   * Returns the batch keys, new or not, so the caller can (re-)enqueue them.
   */
  async registerBatches(runId: string, rawCollection: string, ranges: readonly BatchRange[], progress: { cursor: string | null; done: boolean }): Promise<string[]> {
    const { keys, created } = await this.registerBatchRanges(runId, rawCollection, ranges);
    await this.recordDispatchProgress(runId, rawCollection, { ...progress, batchesAdded: created });
    return keys;
  }

  /**
   * Step 1 of dispatching a page: upsert the batch rows (queued). Returns every
   * key (new or not) and how many were new. The dispatcher enqueues the keys
   * *before* step 2 moves the cursor, so a crash can never skip a range.
   */
  async registerBatchRanges(runId: string, rawCollection: string, ranges: readonly BatchRange[]): Promise<{ keys: string[]; created: number }> {
    const rows = ranges.map((r) => ({ runId, rawCollection, fromId: r.fromId, toId: r.toId, batchKey: batchKeyOf(rawCollection, r.fromId, r.toId) }));
    const created = rows.length > 0 ? await this.batches.createMany(rows, this.clock()) : 0;
    return { keys: rows.map((r) => r.batchKey), created };
  }

  /** Step 2: move the cursor (and dispatchedDocs) and count the new batches. */
  recordDispatchProgress(
    runId: string,
    rawCollection: string,
    progress: { cursor: string | null; batchesAdded: number; done: boolean; dispatchedDocs?: number },
  ): Promise<void> {
    return this.runs.recordDispatch(runId, rawCollection, progress);
  }

  /**
   * Called by each source's dispatcher when it is done. Every dispatcher first
   * records its own dispatchDone and then reads, so the last one to finish always
   * sees all sources done (the transition itself is guarded, so two may race safely).
   */
  async finishDispatchIfComplete(runId: string): Promise<RunStatus> {
    const run = await this.requireRun(runId);
    if (run.status !== 'dispatching' || Object.values(run.sources).some((s) => !s.dispatchDone)) return run.status;
    return this.finishDispatch(runId);
  }

  /** All sources dispatched: dispatching -> running, then finalise if every batch already settled. */
  async finishDispatch(runId: string): Promise<RunStatus> {
    const run = await this.requireRun(runId);
    const pending = Object.entries(run.sources).filter(([, s]) => !s.dispatchDone).map(([c]) => c);
    if (pending.length > 0) throw new Error(`run ${runId}: dispatch not done for ${pending.join(', ')}`);
    await this.runs.transition(runId, ['dispatching'], 'running', { dispatchedAt: this.clock() });
    return this.checkFinalisation(runId);
  }

  /** Unrecoverable run-level failure (e.g. dispatch crashed). Terminal; applies once. */
  failRun(runId: string, error: string): Promise<boolean> {
    return this.finaliseWith(runId, 'failed', { lastError: error });
  }

  // ---------------------------------------------------------------- batches

  /** queued -> active. Returns the attempt number, or null if the batch is already settled (skip it). */
  batchStarted(runId: string, batchKey: string): Promise<number | null> {
    return this.batches.markActive(runId, batchKey, this.clock());
  }

  batchAttemptFailed(runId: string, batchKey: string, error: string): Promise<void> {
    return this.batches.recordFailure(runId, batchKey, error, this.clock());
  }

  async completeBatch(runId: string, batchKey: string, counters: RunCounters, errors: readonly SampledIssue[]): Promise<SettleResult> {
    const applied = await this.batches.complete(runId, batchKey, counters, this.clock());
    if (applied) {
      const n = this.appConfig.errorSampleSize;
      await this.runs.applyBatch(runId, rawCollectionOf(batchKey), 'completed', counters, errors.slice(0, n), n);
    } else {
      await this.requireBatch(runId, batchKey);
    }
    return { applied, runStatus: await this.checkFinalisation(runId) };
  }

  async batchDead(runId: string, batchKey: string, error: string): Promise<SettleResult> {
    const applied = await this.batches.markDead(runId, batchKey, error, this.clock());
    if (applied) {
      await this.runs.applyBatch(runId, rawCollectionOf(batchKey), 'dead', {}, [], this.appConfig.errorSampleSize, `${batchKey}: ${error}`);
    } else {
      await this.requireBatch(runId, batchKey);
    }
    return { applied, runStatus: await this.checkFinalisation(runId) };
  }

  // ---------------------------------------------------------------- quarantine

  quarantine(entries: readonly QuarantineEntry[]): Promise<number> {
    return entries.length > 0 ? this.quarantineRepo.add(entries) : Promise.resolve(0);
  }

  listQuarantine(runId: string, query: QuarantineQuery): Promise<QuarantinePage> {
    return this.quarantineRepo.list(runId, query);
  }

  // ---------------------------------------------------------------- finalisation

  /**
   * Finalise when dispatch is done and every batch of every source is settled.
   * Uses run_batches as the source of truth; safe to call any number of times.
   */
  async checkFinalisation(runId: string): Promise<RunStatus> {
    const run = await this.requireRun(runId);
    if (TERMINAL_RUN_STATUSES.includes(run.status) || run.status !== 'running') return run.status;

    const counts = await this.batches.countByStatus(runId);
    for (const rawCollection of Object.keys(run.sources)) {
      const c = counts[rawCollection];
      const unsettled = c ? c.queued + c.active : 0;
      if (unsettled > 0) return run.status;
    }
    const dead = Object.values(counts).reduce((n, c) => n + c.dead, 0);
    const totals = await this.batches.sumCompletedCounters(runId);
    const status: RunStatus = totals.failed > 0 || dead > 0 ? 'completed_with_errors' : 'completed';
    await this.finaliseWith(runId, status, { run, counts, totals });
    return (await this.requireRun(runId)).status;
  }

  /** The single guarded terminal write, with totals recomputed from run_batches. Returns whether it applied. */
  private async finaliseWith(
    runId: string,
    status: RunStatus,
    known: { run?: Run; counts?: BatchStatusCounts; totals?: RunCounters; lastError?: string } = {},
  ): Promise<boolean> {
    const run = known.run ?? (await this.requireRun(runId));
    const counts = known.counts ?? (await this.batches.countByStatus(runId));
    const counters = known.totals ?? (await this.batches.sumCompletedCounters(runId));
    const sources = Object.fromEntries(
      Object.entries(run.sources).map(([c, s]) => {
        const n = counts[c] ?? ({ queued: 0, active: 0, completed: 0, dead: 0 } as Record<BatchStatus, number>);
        return [c, { ...s, batchesTotal: n.queued + n.active + n.completed + n.dead, batchesDone: n.completed, batchesDead: n.dead }];
      }),
    );
    const finishedAt = this.clock();
    const startedAt = run.timings.startedAt ?? run.timings.createdAt;
    const applied = await this.runs.finalise(runId, {
      status,
      counters,
      sources,
      finishedAt,
      durationMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
      ...(known.lastError === undefined ? {} : { lastError: known.lastError }),
    });
    if (applied) this.logger.log({ runId, status, counters }, 'Run finalised');
    return applied;
  }

  private async requireRun(runId: string): Promise<Run> {
    const run = await this.runs.get(runId);
    if (!run) throw new Error(`unknown run ${runId}`);
    return run;
  }

  private async requireBatch(runId: string, batchKey: string): Promise<void> {
    if (!(await this.batches.get(runId, batchKey))) throw new UnknownBatchError(`unknown batch ${batchKey} in run ${runId}`);
  }
}

/** batchKey = rawCollection:fromId:toId; raw collection names contain no ':'. */
export const rawCollectionOf = (batchKey: string): string => batchKey.slice(0, batchKey.indexOf(':'));
