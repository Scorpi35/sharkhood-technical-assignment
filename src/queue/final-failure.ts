import type { Job } from 'bullmq';

/**
 * Is this `failed` event the job's last one? BullMQ emits `failed` for every
 * failed attempt, including ones it will retry. A job is finished when:
 *  - its attempts are exhausted, or
 *  - it threw UnrecoverableError (BullMQ skips the remaining attempts), or
 *  - it exceeded maxStalledCount (failed without consuming attempts).
 */
export function isFinalFailure(job: Job | undefined, err: Error): job is Job {
  if (!job) return false;
  if (err.name === 'UnrecoverableError') return true;
  if (/stalled more than allowable limit/i.test(err.message)) return true;
  return job.attemptsMade >= (job.opts.attempts ?? 1);
}
