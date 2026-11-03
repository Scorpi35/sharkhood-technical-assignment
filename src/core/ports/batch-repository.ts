export const BATCH_REPOSITORY = Symbol('BatchRepository');

export const BATCH_STATUSES = ['pending', 'running', 'done', 'failed'] as const;
export type BatchStatus = (typeof BATCH_STATUSES)[number];

/** One `_id` range of one raw collection within a run: the unit of work and of retry. */
export interface Batch {
  readonly runId: string;
  /** Deterministic: batchKeyOf(rawCollection, fromId, toId). */
  readonly batchKey: string;
  readonly rawCollection: string;
  /** Inclusive range bounds (see SourceReader.readRange). */
  readonly fromId: string;
  readonly toId: string;
  readonly status: BatchStatus;
  readonly attempts: number;
  readonly counters?: Readonly<Record<string, number>>;
  readonly error?: string;
}

export const batchKeyOf = (rawCollection: string, fromId: string, toId: string): string =>
  `${rawCollection}:${fromId}-${toId}`;

export interface BatchRepository {
  /** Idempotent on (runId, batchKey): re-planning a run does not duplicate batches. */
  createMany(batches: readonly Batch[]): Promise<void>;
  markRunning(runId: string, batchKey: string, at: Date): Promise<void>;
  markDone(runId: string, batchKey: string, counters: Readonly<Record<string, number>>, at: Date): Promise<void>;
  markFailed(runId: string, batchKey: string, error: string, at: Date): Promise<void>;
  /** Served by the (runId, status) index; keyset-paginated by batchKey. */
  listByStatus(runId: string, status: BatchStatus, page: { readonly afterKey?: string; readonly limit: number }): Promise<Batch[]>;
  countByStatus(runId: string): Promise<Record<BatchStatus, number>>;
}
