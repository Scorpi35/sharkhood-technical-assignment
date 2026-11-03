import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, OnApplicationBootstrap } from '@nestjs/common';
import { Job, UnrecoverableError } from 'bullmq';
import { PinoLogger } from 'nestjs-pino';
import {
  PROVIDER_REGISTRY,
  ProviderRegistry,
  ProviderRegistryError,
  RawDocument,
  runPipeline,
  SOURCE_READER,
  SourceReader,
  TARGET_WRITER,
  TargetWriter,
} from '../core';
import { AppConfig } from '../config/app-config';
import { batchCounters, quarantineEntries, sampledErrors } from '../runs/batch-counters';
import { RunsService, UnknownBatchError } from '../runs/runs.service';
import { isFinalFailure } from './final-failure';
import { BATCH_QUEUE_NAME, BatchJobData, WORKER_STALL_OPTIONS } from './queue.constants';
import { QueueProducer } from './queue.producer';

/**
 * One batch = one _id range: read -> pipeline -> upsert -> quarantine -> complete.
 *
 * Document problems never throw: they come back from the pipeline as issues and
 * are quarantined. Infrastructure errors (Mongo, Redis) propagate, so BullMQ
 * retries the batch with exponential backoff. The writes are idempotent, so a
 * retry after a partial attempt is safe. After the last attempt, the batch goes
 * to the dead-letter queue and is marked dead (onFailed).
 */
@Processor(BATCH_QUEUE_NAME, WORKER_STALL_OPTIONS)
export class BatchProcessor extends WorkerHost implements OnApplicationBootstrap {
  constructor(
    private readonly runs: RunsService,
    private readonly producer: QueueProducer,
    @Inject(SOURCE_READER) private readonly reader: SourceReader,
    @Inject(TARGET_WRITER) private readonly writer: TargetWriter,
    @Inject(PROVIDER_REGISTRY) private readonly registry: ProviderRegistry,
    private readonly config: AppConfig,
    private readonly pino: PinoLogger,
  ) {
    super();
  }

  /** Concurrency comes from validated config (decorator options are static, so it is applied here). */
  onApplicationBootstrap(): void {
    this.worker.concurrency = this.config.jobs.concurrency;
  }

  async process(job: Job<BatchJobData>): Promise<unknown> {
    const { runId, rawCollection, fromId, toId, batchKey } = job.data;
    const log = this.pino.logger.child({ runId, jobId: job.id, batchKey });

    const attempt = await this.runs.batchStarted(runId, batchKey);
    if (attempt === null) {
      log.info('Batch already settled; skipping');
      return { skipped: true };
    }

    try {
      let adapter;
      try {
        adapter = this.registry.resolve(rawCollection).adapter;
      } catch (e) {
        if (e instanceof ProviderRegistryError) throw new UnrecoverableError(e.message); // wiring bug: retrying cannot help
        throw e;
      }

      const docs: RawDocument[] = [];
      for await (const doc of this.reader.readRange(rawCollection, fromId, toId)) docs.push(doc);
      const result = runPipeline(docs, adapter);
      const write = await this.writer.upsert(result.records);
      await this.runs.quarantine(quarantineEntries(runId, batchKey, job.id, result.issues));
      const counters = batchCounters(result, write);
      const settled = await this.runs.completeBatch(runId, batchKey, counters, sampledErrors(batchKey, result.issues));

      log.info({ attempt, counters, retired: write.retired ?? 0, applied: settled.applied, runStatus: settled.runStatus }, 'Batch completed');
      return { counters };
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      if (e instanceof UnknownBatchError) throw new UnrecoverableError(e.message);
      log.warn({ err: e, attempt, maxAttempts: job.opts.attempts }, 'Batch attempt failed');
      await this.runs.batchAttemptFailed(runId, batchKey, e.message).catch(() => undefined); // best effort: Mongo may be the problem
      throw e;
    }
  }

  /** Dead letter: after the last attempt, park the batch and let the run finalise without it. */
  @OnWorkerEvent('failed')
  async onFailed(job: Job<BatchJobData> | undefined, err: Error): Promise<void> {
    if (!isFinalFailure(job, err)) return;
    const { runId, batchKey } = job.data;
    const log = this.pino.logger.child({ runId, jobId: job.id, batchKey });
    try {
      await this.producer.addDeadLetter({ runId, batchKey, error: err.message, ...(err.stack ? { stack: err.stack } : {}) });
      const settled = await this.runs.batchDead(runId, batchKey, err.message);
      log.error({ err, attemptsMade: job.attemptsMade, runStatus: settled.runStatus }, 'Batch dead-lettered');
    } catch (e) {
      log.error({ err: e }, 'Could not dead-letter the batch');
    }
  }
}
