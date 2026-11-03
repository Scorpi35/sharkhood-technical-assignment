import type { WorkerOptions } from 'bullmq';

export const DISPATCH_QUEUE_NAME = 'factory-dispatch';
export const BATCH_QUEUE_NAME = 'factory-batch';
export const DEAD_LETTER_QUEUE_NAME = 'factory-dead-letter';

/** One dispatch job per (run, raw collection). */
export interface DispatchJobData {
  readonly runId: string;
  readonly rawCollection: string;
}

/** A batch is a range, never documents: Redis memory does not grow with data volume. */
export interface BatchJobData {
  readonly runId: string;
  readonly rawCollection: string;
  readonly fromId: string;
  readonly toId: string;
  readonly batchKey: string;
}

export interface DeadLetterJobData {
  readonly runId: string;
  readonly batchKey: string;
  readonly error: string;
  readonly stack?: string;
}

/*
 * Deterministic job ids: BullMQ ignores an add() whose id already exists, so
 * re-dispatching can never double-enqueue. BullMQ 6 rejects ':' in custom ids,
 * and batch keys contain ':' (rawCollection:fromId:toId), so ':' becomes '__'.
 */
const safe = (s: string): string => s.replace(/:/g, '__');
export const dispatchJobId = (runId: string, rawCollection: string): string => `dispatch__${safe(runId)}__${safe(rawCollection)}`;
export const batchJobId = (runId: string, batchKey: string): string => `batch__${safe(runId)}__${safe(batchKey)}`;
export const deadLetterJobId = (runId: string, batchKey: string): string => `dead__${safe(runId)}__${safe(batchKey)}`;

/**
 * Stalled-job recovery: this is what resumes a killed worker's active job
 * (`docker compose kill worker`), so it is set explicitly rather than left to defaults.
 */
export const WORKER_STALL_OPTIONS: Pick<WorkerOptions, 'lockDuration' | 'stalledInterval' | 'maxStalledCount'> = {
  // A worker holds a lock on each active job and renews it every lockDuration / 2.
  // If the worker dies, nobody renews it, and the lock expires after this long.
  lockDuration: 30_000,
  // Every stalledInterval, workers look for active jobs whose lock has expired and
  // move them back to waiting, so another (or the restarted) worker picks them up.
  // Worst case, a killed worker's batch resumes after lockDuration + stalledInterval.
  stalledInterval: 15_000,
  // A job that stalls more than this many times is failed, so a batch that crashes
  // its worker every time (e.g. out of memory) cannot cycle forever. It then goes
  // through the normal dead-letter path.
  maxStalledCount: 2,
};
