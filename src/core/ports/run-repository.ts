import type { Issue } from '../pipeline/types';

export const RUN_REPOSITORY = Symbol('RunRepository');

export const RUN_STATUSES = ['pending', 'dispatching', 'running', 'completed', 'completed_with_errors', 'failed'] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];
export const TERMINAL_RUN_STATUSES: readonly RunStatus[] = ['completed', 'completed_with_errors', 'failed'];

/** Definitions live in ARCHITECTURE.md ("Run counters"). */
export const COUNTER_NAMES = ['read', 'transformed', 'written', 'unchanged', 'stale', 'deduplicated', 'skipped', 'failed', 'warnings'] as const;
export type CounterName = (typeof COUNTER_NAMES)[number];
export type RunCounters = Record<CounterName, number>;
export const zeroCounters = (): RunCounters => Object.fromEntries(COUNTER_NAMES.map((n) => [n, 0])) as RunCounters;

/** Dispatch and completion progress of one raw collection within a run. */
export interface RunSourceProgress {
  /** Last raw id handed to a batch; dispatch resumes after it. */
  readonly dispatchCursor: string | null;
  /** Raw documents covered by registered batches so far (for the `limit` filter; survives restarts). */
  readonly dispatchedDocs: number;
  readonly dispatchDone: boolean;
  readonly batchesTotal: number;
  readonly batchesDone: number;
  readonly batchesDead: number;
}

export interface RunConfig {
  readonly batchSizes: Readonly<Record<string, number>>;
  readonly concurrency: number;
  readonly attempts: number;
}

export interface RunTimings {
  readonly createdAt: Date;
  readonly startedAt?: Date;
  readonly dispatchedAt?: Date;
  readonly finishedAt?: Date;
  readonly durationMs?: number;
}

/** An Issue as kept in the run's capped error sample. */
export interface SampledIssue extends Issue {
  readonly sourceId: string;
  readonly rawCollection: string;
  readonly batchKey: string;
}

/**
 * One migration run: everything needed to answer "what did this run do?".
 * Run metadata is the only place wall-clock time and runId live.
 */
export interface Run {
  readonly runId: string;
  readonly status: RunStatus;
  readonly filters: Readonly<Record<string, unknown>>;
  readonly config: RunConfig;
  readonly sources: Readonly<Record<string, RunSourceProgress>>;
  readonly counters: RunCounters;
  readonly timings: RunTimings;
  readonly errorSample: readonly SampledIssue[];
  readonly lastError?: string;
}

export interface RunRepository {
  create(run: Run): Promise<void>;
  get(runId: string): Promise<Run | null>;
  /** Guarded status change: applies only if the current status is one of `from`. Returns whether it applied. */
  transition(runId: string, from: readonly RunStatus[], to: RunStatus, timings?: Partial<RunTimings>, lastError?: string): Promise<boolean>;
  /**
   * Record dispatch progress for one source: $set the cursor and dispatchedDocs
   * (absolute values, so a retried page is idempotent), $inc batchesTotal by the
   * newly created batches, maybe mark done.
   */
  recordDispatch(
    runId: string,
    rawCollection: string,
    progress: { cursor: string | null; batchesAdded: number; done: boolean; dispatchedDocs?: number },
  ): Promise<void>;
  /**
   * Live progress after a batch settled exactly once: $inc counters and the
   * source's batchesDone (or batchesDead), push errors into the capped sample.
   */
  applyBatch(
    runId: string,
    rawCollection: string,
    outcome: 'completed' | 'dead',
    counters: Partial<RunCounters>,
    errors: readonly SampledIssue[],
    errorSampleSize: number,
    lastError?: string,
  ): Promise<void>;
  /**
   * Terminal transition with authoritative totals (recomputed from run_batches).
   * Applies only if the run is not already terminal. Returns whether it applied.
   */
  finalise(
    runId: string,
    final: {
      status: RunStatus;
      counters: RunCounters;
      sources: Readonly<Record<string, RunSourceProgress>>;
      finishedAt: Date;
      durationMs: number;
      lastError?: string;
    },
  ): Promise<boolean>;
}
