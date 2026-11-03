import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { BatchStatus, RunStatus, TERMINAL_RUN_STATUSES } from '../core';
import { RunAlreadyFinishedError, RunNotFoundError } from '../runs/runs.errors';
import { RunsService } from '../runs/runs.service';
import { BATCH_QUEUE_NAME, batchJobId, DISPATCH_QUEUE_NAME, dispatchJobId } from './queue.constants';
import { QueueProducer } from './queue.producer';

export interface ResumeReport {
  readonly runId: string;
  /** Status after the resume (unchanged if the run was already terminal). */
  readonly status: RunStatus;
  /** True if this resume (or work it unblocked) finalised the run. */
  readonly terminal: boolean;
  /** Sources whose dispatch job was missing or dead in Redis and was re-enqueued. */
  readonly dispatchRequeued: string[];
  /** Unsettled batches whose job was missing or dead in Redis and was re-enqueued. */
  readonly batchesRequeued: number;
}

/** BullMQ states in which a job will still run by itself (stalled active jobs are recovered by the stall checker). */
const LIVE_STATES = new Set(['waiting', 'active', 'delayed', 'prioritized', 'waiting-children']);
const UNSETTLED: readonly BatchStatus[] = ['queued', 'active'];
const PAGE = 500;

/**
 * Re-attach a run's durable state (Mongo) to the queue (Redis). Covers Redis
 * losing state, and a crash at any point that left work unscheduled:
 *  - pending run (crash before dispatch started): start dispatching;
 *  - every source not dispatchDone: its dispatch job must be live, else re-enqueue it
 *    (the dispatcher resumes after dispatchCursor);
 *  - every batch still queued/active in run_batches: its job must be live, else re-enqueue it;
 *  - finally, finish dispatch / finalisation if a crash interrupted them.
 * Safe to call any time, from any number of processes: job ids are deterministic
 * and every step is idempotent. Live jobs are never touched.
 */
@Injectable()
export class RunResumer {
  private readonly logger = new Logger(RunResumer.name);

  constructor(
    private readonly runs: RunsService,
    private readonly producer: QueueProducer,
    @InjectQueue(DISPATCH_QUEUE_NAME) private readonly dispatchQueue: Queue,
    @InjectQueue(BATCH_QUEUE_NAME) private readonly batchQueue: Queue,
  ) {}

  async resumeAll(): Promise<ResumeReport[]> {
    const reports: ResumeReport[] = [];
    for (const runId of await this.runs.listResumableRunIds()) {
      try {
        reports.push(await this.resume(runId));
      } catch (err) {
        if (!(err instanceof RunAlreadyFinishedError)) throw err; // finished meanwhile: nothing to do
      }
    }
    return reports;
  }

  /** RunNotFoundError for an unknown run, RunAlreadyFinishedError if it had already finished. */
  async resume(runId: string): Promise<ResumeReport> {
    let run = await this.runs.getRun(runId);
    if (!run) throw new RunNotFoundError(runId);
    if (TERMINAL_RUN_STATUSES.includes(run.status)) throw new RunAlreadyFinishedError(runId, run.status);
    if (run.status === 'pending') {
      await this.runs.startDispatch(runId);
      run = (await this.runs.getRun(runId))!;
    }

    const dispatchRequeued: string[] = [];
    for (const [rawCollection, source] of Object.entries(run.sources)) {
      if (source.dispatchDone) continue;
      if (await this.ensureJob(this.dispatchQueue, dispatchJobId(runId, rawCollection), () => this.producer.enqueueDispatch(runId, rawCollection))) {
        dispatchRequeued.push(rawCollection);
      }
    }

    let batchesRequeued = 0;
    for (const status of UNSETTLED) {
      let afterKey: string | undefined;
      for (;;) {
        const page = await this.runs.listBatches(runId, status, { afterKey, limit: PAGE });
        for (const b of page) {
          const requeued = await this.ensureJob(this.batchQueue, batchJobId(runId, b.batchKey), () =>
            this.producer.enqueueBatches([{ runId, rawCollection: b.rawCollection, fromId: b.fromId, toId: b.toId, batchKey: b.batchKey }]),
          );
          if (requeued) batchesRequeued += 1;
        }
        if (page.length < PAGE) break;
        afterKey = page[page.length - 1].batchKey;
      }
    }

    await this.runs.finishDispatchIfComplete(runId);
    const status = await this.runs.checkFinalisation(runId);
    const report = { runId, status, terminal: TERMINAL_RUN_STATUSES.includes(status), dispatchRequeued, batchesRequeued };
    if (dispatchRequeued.length > 0 || batchesRequeued > 0) this.logger.warn(report, 'Run resumed: re-enqueued work missing from Redis');
    return report;
  }

  /**
   * Make sure a job with this id will run. Returns true if it had to be (re-)enqueued.
   * A job that exists but is finished (completed/failed) while its unit of work is
   * still unsettled is stale: it is removed so the deterministic id can be reused.
   */
  private async ensureJob(queue: Queue, jobId: string, add: () => Promise<void>): Promise<boolean> {
    const job = await queue.getJob(jobId);
    if (job) {
      const state = await job.getState();
      if (LIVE_STATES.has(state)) return false;
      await job.remove().catch(() => undefined); // e.g. another process removed or locked it first
    }
    await add();
    return true;
  }
}
