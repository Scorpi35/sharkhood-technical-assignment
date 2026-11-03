import { Global, Inject, Logger, Module, OnApplicationShutdown } from '@nestjs/common';
import { Db, MongoClient } from 'mongodb';
import { SOURCE_READER } from '../../core';
import { AppConfig } from '../../config/app-config';
import { MONGO_PING } from '../../health/health.ports';
import { mongoPing } from './mongo-ping';
import { MongoSourceReader } from './mongo-source-reader';
import { MONGO_CLIENT, RAW_DB, TARGET_DB } from './mongo.tokens';

/**
 * One MongoClient for the process, connected at startup, closed on shutdown.
 * Exposes the raw and target databases as separate Db tokens, and the
 * SourceReader (bound to the raw database only).
 */
@Global()
@Module({
  providers: [
    {
      provide: MONGO_CLIENT,
      inject: [AppConfig],
      useFactory: async (config: AppConfig): Promise<MongoClient> => {
        const client = new MongoClient(config.mongo.uri, { serverSelectionTimeoutMS: 10_000, appName: `sharkhood-${config.role}` });
        await client.connect();
        return client;
      },
    },
    { provide: RAW_DB, inject: [MONGO_CLIENT, AppConfig], useFactory: (c: MongoClient, config: AppConfig): Db => c.db(config.mongo.rawDbName) },
    { provide: TARGET_DB, inject: [MONGO_CLIENT, AppConfig], useFactory: (c: MongoClient, config: AppConfig): Db => c.db(config.mongo.targetDbName) },
    { provide: SOURCE_READER, inject: [RAW_DB], useFactory: (raw: Db) => new MongoSourceReader(raw) },
    { provide: MONGO_PING, inject: [RAW_DB, TARGET_DB], useFactory: mongoPing },
  ],
  exports: [MONGO_CLIENT, RAW_DB, TARGET_DB, SOURCE_READER, MONGO_PING],
})
export class MongoModule implements OnApplicationShutdown {
  private readonly logger = new Logger(MongoModule.name);

  constructor(@Inject(MONGO_CLIENT) private readonly client: MongoClient) {}

  async onApplicationShutdown(): Promise<void> {
    await this.client.close();
    this.logger.log('Mongo client closed');
  }
}
