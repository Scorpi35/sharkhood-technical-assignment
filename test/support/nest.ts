import { Global, Module, type INestApplicationContext, type ModuleMetadata } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { CLOCK, Clock } from '../../src/core';
import { AppConfig } from '../../src/config/app-config';
import { parseEnv } from '../../src/config/env.schema';
import { DomainModule } from '../../src/domain/domain.module';
import { MongoModule } from '../../src/infra/mongo/mongo.module';
import { MONGO_CLIENT } from '../../src/infra/mongo/mongo.tokens';
import { RunsModule } from '../../src/runs/runs.module';
import { connectTestClient } from './mongo';

interface BootOptions {
  readonly imports: NonNullable<ModuleMetadata['imports']>;
  readonly env?: Readonly<Record<string, string>>;
  readonly clock?: Clock;
}

/**
 * Boot real modules the way the app does (module init creates the indexes),
 * against `mongoUri` and a fresh target database. Swapped for tests: the
 * MongoClient factory (Jest-safe, driver bug NODE-7832), the AppConfig, and
 * optionally the clock.
 */
async function boot(mongoUri: string, targetDbName: string, opts: BootOptions): Promise<INestApplicationContext> {
  const config = new AppConfig(
    parseEnv({ MONGO_URI: mongoUri, REDIS_URL: 'redis://unused:6379', TARGET_DB_NAME: targetDbName, RAW_DB_NAME: `${targetDbName}_raw`, ...opts.env }),
  );

  @Global()
  @Module({ providers: [{ provide: AppConfig, useValue: config }], exports: [AppConfig] })
  class TestConfigModule {}

  let builder = Test.createTestingModule({ imports: [TestConfigModule, MongoModule, ...opts.imports] })
    .overrideProvider(MONGO_CLIENT)
    .useFactory({ factory: () => connectTestClient(mongoUri) });
  if (opts.clock) builder = builder.overrideProvider(CLOCK).useValue(opts.clock);
  const moduleRef = await builder.compile();
  await moduleRef.init();
  return moduleRef;
}

/** MongoModule + DomainModule (TARGET_WRITER and all repositories). */
export const bootDomain = (mongoUri: string, targetDbName: string) => boot(mongoUri, targetDbName, { imports: [DomainModule] });

/** MongoModule + RunsModule (RunsService), with an optional fixed/controllable clock and env overrides. */
export const bootRuns = (mongoUri: string, targetDbName: string, opts: Omit<BootOptions, 'imports'> = {}) =>
  boot(mongoUri, targetDbName, { ...opts, imports: [RunsModule] });

/** A manually advanced clock for deterministic timings. */
export function manualClock(start = new Date('2026-11-03T10:00:00.000Z')): Clock & { advance(ms: number): void } {
  let now = start.getTime();
  const clock = (() => new Date(now)) as Clock & { advance(ms: number): void };
  clock.advance = (ms) => (now += ms);
  return clock;
}
