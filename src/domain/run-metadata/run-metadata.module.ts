import { Inject, Injectable, Module, OnModuleInit } from '@nestjs/common';
import type { Db } from 'mongodb';
import { BATCH_REPOSITORY, QUARANTINE_REPOSITORY, RUN_REPOSITORY } from '../../core';
import { TARGET_DB } from '../../infra/mongo/mongo.tokens';
import { ensureIndexes } from '../shared/versioned-upsert';
import { MongoBatchRepository } from './batch.repository';
import { MongoQuarantineRepository } from './quarantine.repository';
import { RUN_METADATA_INDEXES } from './run-metadata.indexes';
import { MongoRunRepository } from './run.repository';

@Injectable()
export class RunMetadataIndexes implements OnModuleInit {
  constructor(@Inject(TARGET_DB) private readonly db: Db) {}

  async onModuleInit(): Promise<void> {
    for (const [name, indexes] of Object.entries(RUN_METADATA_INDEXES)) await ensureIndexes(this.db.collection(name), indexes);
  }
}

/** Mongo implementations of the run-metadata ports (runs, run_batches, quarantine). */
@Module({
  providers: [
    RunMetadataIndexes,
    { provide: RUN_REPOSITORY, useClass: MongoRunRepository },
    { provide: BATCH_REPOSITORY, useClass: MongoBatchRepository },
    { provide: QUARANTINE_REPOSITORY, useClass: MongoQuarantineRepository },
  ],
  exports: [RUN_REPOSITORY, BATCH_REPOSITORY, QUARANTINE_REPOSITORY],
})
export class RunMetadataModule {}
