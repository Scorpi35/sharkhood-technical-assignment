import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject } from '@nestjs/common';
import { Job, UnrecoverableError } from 'bullmq';
import { PinoLogger } from 'nestjs-pino';
import { SOURCE_READER, SourceReader, TERMINAL_RUN_STATUSES } from '../core';
import { RunsService } from '../runs/runs.service';
import { isFinalFailure } from './final-failure';
import { DISPATCH_QUEUE_NAME, DispatchJobData, WORKER_STALL_OPTIONS } from './queue.constants';
import { QueueProducer } from './queue.producer';

/**
 * Pages one raw collection by _id and turns each page into a batch job.
 * Resumable: progress (cursor, dispatchedDocs) lives on the run, so a retried or
 * restarted dispatch continues after the last recorded page. Per page:
 *   1. upsert the run_batches row (queued)            -- idempotent
 *   2. enqueue the batch job with a deterministic id  -- idempotent
 *   3. $set cursor/dispatchedDocs, $inc batchesTotal by the newly created rows
 * The cursor only moves after the job is enqueued, so a crash never skips a range.
 */
@Processor(DISPATCH_QUEUE_NAME, { ...WORKER_STALL_OPTIONS, concurrency: 1 })
export class DispatchProcessor extends WorkerHost {
  constructor(
    private readonly runs: RunsService,
    private readonly producer: QueueProducer,
    @Inject(SOURCE_READER) private readonly reader: SourceReader,
    private readonly pino: PinoLogger,
  ) {
    super();
  }

  async process(job: Job<DispatchJobData>): Promise<{ batches: number; docs: number }> {
    const { runId, rawCollection } = job.data;
    const log = this.pino.logger.child({ runId, jobId: job.id, rawCollection });

    const run = await this.runs.getRun(runId);
    if (!run) throw new UnrecoverableError(`unknown run ${runId}`);
    if (TERMINAL_RUN_STATUSES.includes(run.status)) return { batches: 0, docs: 0 };
    const source = run.sources[rawCollection];
    if (!source) throw new UnrecoverableError(`run ${runId} has no source ${rawCollection}`);
    const batchSize = run.config.batchSizes[rawCollection];
    if (!Number.isInteger(batchSize) || batchSize < 1) throw new UnrecoverableError(`run ${runId}: no batch size for ${rawCollection}`);
    const limit = typeof run.filters.limit === 'number' ? run.filters.limit : undefined;

    let cursor = source.dispatchCursor;
    let dispatched = source.dispatchedDocs ?? 0;
    let pages = 0;
    if (!source.dispatchDone && (limit === undefined || dispatched < limit)) {
      for await (const page of this.reader.scanIds(rawCollection, { afterId: cursor ?? undefined, limit: batchSize })) {
        const ids = limit === undefined ? page : page.slice(0, limit - dispatched);
        if (ids.length === 0) break;
        const range = { fromId: ids[0], toId: ids[ids.length - 1] };

        const { keys, created } = await this.runs.registerBatchRanges(runId, rawCollection, [range]);
        await this.producer.enqueueBatches(keys.map((batchKey) => ({ runId, rawCollection, ...range, batchKey })));
        dispatched += ids.length;
        cursor = range.toId;
        await this.runs.recordDispatchProgress(runId, rawCollection, { cursor, dispatchedDocs: dispatched, batchesAdded: created, done: false });
        pages += 1;
        if (limit !== undefined && dispatched >= limit) break;
      }
    }
    await this.runs.recordDispatchProgress(runId, rawCollection, { cursor, dispatchedDocs: dispatched, batchesAdded: 0, done: true });
    const status = await this.runs.finishDispatchIfComplete(runId);
    log.info({ pages, dispatchedDocs: dispatched, runStatus: status }, 'Dispatch done');
    return { batches: pages, docs: dispatched };
  }

  /** A dispatch that cannot finish leaves the run unable to finalise: fail the run. */
  @OnWorkerEvent('failed')
  async onFailed(job: Job<DispatchJobData> | undefined, err: Error): Promise<void> {
    if (!isFinalFailure(job, err)) return;
    const log = this.pino.logger.child({ runId: job.data.runId, jobId: job.id, rawCollection: job.data.rawCollection });
    try {
      await this.runs.failRun(job.data.runId, `dispatch of ${job.data.rawCollection} failed: ${err.message}`);
      log.error({ err }, 'Dispatch failed permanently; run failed');
    } catch (e) {
      log.error({ err: e }, 'Could not mark the run failed after a permanent dispatch failure');
    }
  }
}
