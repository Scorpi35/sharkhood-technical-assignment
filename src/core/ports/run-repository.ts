export const RUN_REPOSITORY = Symbol('RunRepository');

export const RUN_STATUSES = ['pending', 'running', 'completed', 'failed'] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

/**
 * One migration run. Run metadata is the only place wall-clock time and runId
 * live; target documents never contain them. Times are passed in by the caller,
 * since core has no clock.
 */
export interface Run {
  readonly runId: string;
  readonly provider: string;
  readonly rawCollections: readonly string[];
  readonly status: RunStatus;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  /** Aggregated pipeline/write counters, e.g. { records: 1234, quarantined: 5 }. */
  readonly counters: Readonly<Record<string, number>>;
}

export interface RunRepository {
  create(run: Run): Promise<void>;
  get(runId: string): Promise<Run | null>;
  setStatus(runId: string, status: RunStatus, at: Date): Promise<void>;
  /** Atomically add to counters ($inc semantics), so concurrent batches can report. */
  incrementCounters(runId: string, deltas: Readonly<Record<string, number>>, at: Date): Promise<void>;
}
