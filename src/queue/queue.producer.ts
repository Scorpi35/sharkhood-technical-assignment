import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import type { Queue } from 'bullmq';
import type { DispatchQueue } from '../core';
import { batchJobId, BATCH_QUEUE_NAME, BatchJobData, DEAD_LETTER_QUEUE_NAME, DeadLetterJobData, deadLetterJobId, DISPATCH_QUEUE_NAME, dispatchJobId, DispatchJobData } from './queue.constants';

/** The only code that adds jobs. Every job id is deterministic, so every add is idempotent. */
@Injectable()
export class QueueProducer implements DispatchQueue {
  constructor(
    @InjectQueue(DISPATCH_QUEUE_NAME) private readonly dispatch: Queue<DispatchJobData>,
    @InjectQueue(BATCH_QUEUE_NAME) private readonly batch: Queue<BatchJobData>,
    @InjectQueue(DEAD_LETTER_QUEUE_NAME) private readonly deadLetter: Queue<DeadLetterJobData>,
  ) {}

  async enqueueDispatch(runId: string, rawCollection: string): Promise<void> {
    await this.dispatch.add('dispatch', { runId, rawCollection }, { jobId: dispatchJobId(runId, rawCollection) });
  }

  async enqueueBatches(jobs: readonly BatchJobData[]): Promise<void> {
    if (jobs.length === 0) return;
    await this.batch.addBulk(jobs.map((data) => ({ name: 'batch', data, opts: { jobId: batchJobId(data.runId, data.batchKey) } })));
  }

  async addDeadLetter(data: DeadLetterJobData): Promise<void> {
    await this.deadLetter.add('dead-letter', data, { jobId: deadLetterJobId(data.runId, data.batchKey) });
  }
}
