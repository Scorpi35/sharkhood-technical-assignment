import type { RunCounters } from './run-repository';

export const BATCH_REPOSITORY = Symbol('BatchRepository');

export const BATCH_STATUSES = ['queued', 'active', 'completed', 'dead'] as const;
export type BatchStatus = (typeof BATCH_STATUSES)[number];
/** Settled batches never change status again. */
export const SETTLED_BATCH_STATUSES: readonly BatchStatus[] = ['completed', 'dead'];

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
  readonly counters?: RunCounters;
  readonly lastError?: string;
}

export const batchKeyOf = (rawCollection: string, fromId: string, toId: string): string => `${rawCollection}:${fromId}:${toId}`;

/** Per raw collection: how many of the run's batches are in each status. */
export type BatchStatusCounts = Record<string, Record<BatchStatus, number>>;

export interface BatchRepository {
  /** Idempotent on (runId, batchKey): re-dispatching a range never duplicates it. Returns how many were new. */
  createMany(batches: readonly Omit<Batch, 'status' | 'attempts'>[], at: Date): Promise<number>;
  /** queued -> active (attempts + 1). No-op for settled batches. Returns the attempt number, or null if settled. */
  markActive(runId: string, batchKey: string, at: Date): Promise<number | null>;
  /** An attempt failed but will be retried: active -> queued, lastError recorded. */
  recordFailure(runId: string, batchKey: string, error: string, at: Date): Promise<void>;
  /**
   * -> completed with counters, only if not already settled. Returns true only for
   * the call that made the transition: the exactly-once gate for run counters.
   */
  complete(runId: string, batchKey: string, counters: RunCounters, at: Date): Promise<boolean>;
  /** -> dead (attempts exhausted), only if not already settled. Returns true if it transitioned. */
  markDead(runId: string, batchKey: string, error: string, at: Date): Promise<boolean>;
  get(runId: string, batchKey: string): Promise<Batch | null>;
  countByStatus(runId: string): Promise<BatchStatusCounts>;
  /** Sum of the counters of the run's completed batches: the authoritative run totals. */
  sumCompletedCounters(runId: string): Promise<RunCounters>;
  /** Served by the (runId, status) index; keyset-paginated by batchKey. */
  listByStatus(runId: string, status: BatchStatus, page: { readonly afterKey?: string; readonly limit: number }): Promise<Batch[]>;
}
