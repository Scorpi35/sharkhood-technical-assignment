import { BullModule } from '@nestjs/bullmq';
import { Global, Module } from '@nestjs/common';
import { DISPATCH_QUEUE } from '../core';
import { REDIS_PING } from '../health/health.ports';
import { AppConfig } from '../config/app-config';
import { BATCH_QUEUE_NAME, DEAD_LETTER_QUEUE_NAME, DISPATCH_QUEUE_NAME } from './queue.constants';
import { QueueProducer } from './queue.producer';
import { RedisHealthClient } from './redis-ping';
import { redisConnectionOptions } from './redis-connection';

/** Retries, backoff and retention from validated config: the same for dispatch and batch jobs. */
const workJobOptions = (config: AppConfig) => ({
  defaultJobOptions: {
    attempts: config.jobs.attempts,
    backoff: { type: 'exponential' as const, delay: config.jobs.backoffMs },
    removeOnComplete: 1000,
    removeOnFail: false, // failed jobs stay inspectable (and their ids keep blocking re-adds)
  },
});

/**
 * The three queues and the producer. Imported by every role: the api starts
 * runs (dispatch jobs). Processors live in WorkerQueueModule (worker role only).
 */
@Global()
@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [AppConfig],
      useFactory: (config: AppConfig) => ({ connection: redisConnectionOptions(config.redis.url) }),
    }),
    BullModule.registerQueueAsync(
      { name: DISPATCH_QUEUE_NAME, inject: [AppConfig], useFactory: workJobOptions },
      { name: BATCH_QUEUE_NAME, inject: [AppConfig], useFactory: workJobOptions },
      // Dead letters are records, not work: kept until someone looks at them.
      { name: DEAD_LETTER_QUEUE_NAME, useFactory: () => ({ defaultJobOptions: { removeOnComplete: false, removeOnFail: false } }) },
    ),
  ],
  providers: [
    QueueProducer,
    { provide: DISPATCH_QUEUE, useExisting: QueueProducer },
    RedisHealthClient,
    { provide: REDIS_PING, inject: [RedisHealthClient], useFactory: (c: RedisHealthClient) => c.ping },
  ],
  exports: [BullModule, QueueProducer, DISPATCH_QUEUE, REDIS_PING],
})
export class QueueModule {}
