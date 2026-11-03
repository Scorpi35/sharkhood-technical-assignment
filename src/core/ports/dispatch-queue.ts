/**
 * Starts the asynchronous part of a run. Implemented by the queue module
 * (BullMQ); RunsService depends only on this interface, so the run bookkeeping
 * is testable without Redis and there is no module cycle with the workers.
 */
export const DISPATCH_QUEUE = Symbol('DispatchQueue');

export interface DispatchQueue {
  /** Enqueue the dispatcher for one source of a run. Idempotent (deterministic job id). */
  enqueueDispatch(runId: string, rawCollection: string): Promise<void>;
}
