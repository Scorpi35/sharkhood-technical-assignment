import { Global, Module, type INestApplicationContext, type ModuleMetadata, type Provider } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { CLOCK, Clock, DISPATCH_QUEUE, DispatchQueue } from '../../src/core';
import { AppConfig } from '../../src/config/app-config';
import { parseEnv } from '../../src/config/env.schema';
import { DomainModule } from '../../src/domain/domain.module';
import { MongoModule } from '../../src/infra/mongo/mongo.module';
import { MONGO_CLIENT } from '../../src/infra/mongo/mongo.tokens';
import { LoggingModule } from '../../src/logging/logging.module';
import { ProvidersModule } from '../../src/providers/providers.module';
import { QueueModule } from '../../src/queue/queue.module';
import { RunResumeModule } from '../../src/queue/run-resume.module';
import { WorkerQueueModule } from '../../src/queue/worker-queue.module';
import { RunsModule } from '../../src/runs/runs.module';
import { connectTestClient } from './mongo';

interface BootOptions {
  readonly imports: NonNullable<ModuleMetadata['imports']>;
  readonly env?: Readonly<Record<string, string>>;
  readonly clock?: Clock;
  /** Extra global providers, e.g. a stub DISPATCH_QUEUE when QueueModule is not booted. */
  readonly globals?: readonly Provider[];
  /** Replace real providers (e.g. TARGET_WRITER with a failing double). */
  readonly overrides?: readonly { token: unknown; useValue?: unknown; useFactory?: (...args: never[]) => unknown; inject?: unknown[] }[];
}

/**
 * Boot real modules the way the app does (module init creates indexes, workers
 * start), against `mongoUri` and a fresh target database. Swapped for tests: the
 * MongoClient factory (Jest-safe, driver bug NODE-7832), the AppConfig, and
 * whatever `clock` / `overrides` say.
 */
async function boot(mongoUri: string, targetDbName: string, opts: BootOptions): Promise<INestApplicationContext> {
  const config = new AppConfig(
    parseEnv({
      MONGO_URI: mongoUri,
      REDIS_URL: 'redis://unused:6379',
      TARGET_DB_NAME: targetDbName,
      RAW_DB_NAME: `${targetDbName}_raw`,
      LOG_LEVEL: 'silent',
      ...opts.env,
    }),
  );

  @Global()
  @Module({ providers: [{ provide: AppConfig, useValue: config }, ...(opts.globals ?? [])], exports: [AppConfig, ...(opts.globals ?? []).map(tokenOf)] })
  class TestGlobalsModule {}

  let builder = Test.createTestingModule({ imports: [TestGlobalsModule, MongoModule, ...opts.imports] })
    .overrideProvider(MONGO_CLIENT)
    .useFactory({ factory: () => connectTestClient(mongoUri) });
  if (opts.clock) builder = builder.overrideProvider(CLOCK).useValue(opts.clock);
  for (const o of opts.overrides ?? []) {
    const p = builder.overrideProvider(o.token);
    builder = o.useFactory ? p.useFactory({ factory: o.useFactory, inject: o.inject as never }) : p.useValue(o.useValue);
  }
  const moduleRef = await builder.compile();
  await moduleRef.init();
  return moduleRef;
}

const tokenOf = (p: Provider): string | symbol | Provider => (typeof p === 'function' ? p : (p as { provide: string | symbol }).provide);

/** A DispatchQueue that only records calls (RunsService without Redis). */
export function recordingDispatchQueue(): DispatchQueue & { calls: { runId: string; rawCollection: string }[] } {
  const calls: { runId: string; rawCollection: string }[] = [];
  return { calls, enqueueDispatch: async (runId, rawCollection) => void calls.push({ runId, rawCollection }) };
}

/** MongoModule + DomainModule (TARGET_WRITER and all repositories). */
export const bootDomain = (mongoUri: string, targetDbName: string) => boot(mongoUri, targetDbName, { imports: [DomainModule] });

/** MongoModule + RunsModule (RunsService), with a recording DISPATCH_QUEUE, optional clock and env overrides. */
export const bootRuns = (mongoUri: string, targetDbName: string, opts: Omit<BootOptions, 'imports'> & { dispatchQueue?: DispatchQueue } = {}) =>
  boot(mongoUri, targetDbName, {
    ...opts,
    imports: [RunsModule],
    globals: [...(opts.globals ?? []), { provide: DISPATCH_QUEUE, useValue: opts.dispatchQueue ?? recordingDispatchQueue() }],
  });

/** The whole worker process: Mongo, domain, providers, runs, queues and the BullMQ workers. */
export const bootWorker = (mongoUri: string, targetDbName: string, opts: Omit<BootOptions, 'imports'> & { redisUrl: string }) =>
  boot(mongoUri, targetDbName, {
    ...opts,
    env: { REDIS_URL: opts.redisUrl, ...opts.env },
    imports: [LoggingModule, DomainModule, ProvidersModule, RunsModule, QueueModule, WorkerQueueModule],
  });

/** The api process: queues, RunsService and RunResumer, but no BullMQ workers (enqueued work waits for a worker). */
export const bootProducer = (mongoUri: string, targetDbName: string, opts: Omit<BootOptions, 'imports'> & { redisUrl: string }) =>
  boot(mongoUri, targetDbName, {
    ...opts,
    env: { REDIS_URL: opts.redisUrl, ...opts.env },
    imports: [LoggingModule, DomainModule, ProvidersModule, RunsModule, QueueModule, RunResumeModule],
  });

/** A manually advanced clock for deterministic timings. */
export function manualClock(start = new Date('2026-11-03T10:00:00.000Z')): Clock & { advance(ms: number): void } {
  let now = start.getTime();
  const clock = (() => new Date(now)) as Clock & { advance(ms: number): void };
  clock.advance = (ms) => (now += ms);
  return clock;
}
