import { Global, Module, type INestApplicationContext } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppConfig } from '../../src/config/app-config';
import { parseEnv } from '../../src/config/env.schema';
import { DomainModule } from '../../src/domain/domain.module';
import { MongoModule } from '../../src/infra/mongo/mongo.module';
import { MONGO_CLIENT } from '../../src/infra/mongo/mongo.tokens';
import { connectTestClient } from './mongo';

/**
 * Boot MongoModule + DomainModule exactly as the app does (module init creates
 * the indexes), against `mongoUri` and a fresh target database. Only the
 * MongoClient factory is swapped for the Jest-safe one (driver bug NODE-7832).
 */
export async function bootDomain(mongoUri: string, targetDbName: string): Promise<INestApplicationContext> {
  const config = new AppConfig(
    parseEnv({ MONGO_URI: mongoUri, REDIS_URL: 'redis://unused:6379', TARGET_DB_NAME: targetDbName, RAW_DB_NAME: `${targetDbName}_raw` }),
  );

  @Global()
  @Module({ providers: [{ provide: AppConfig, useValue: config }], exports: [AppConfig] })
  class TestConfigModule {}

  const moduleRef = await Test.createTestingModule({ imports: [TestConfigModule, MongoModule, DomainModule] })
    .overrideProvider(MONGO_CLIENT)
    .useFactory({ factory: () => connectTestClient(mongoUri) })
    .compile();
  await moduleRef.init();
  return moduleRef;
}
