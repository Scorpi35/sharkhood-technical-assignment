import { Inject, Injectable, Module, OnModuleInit } from '@nestjs/common';
import type { Db, IndexDescription } from 'mongodb';
import { TARGET_DB } from '../../infra/mongo/mongo.tokens';
import { ensureIndexes } from '../shared/versioned-upsert';

export const QUARANTINE = 'quarantine';
export const RUN_BATCHES = 'run_batches';
export const RUNS = 'runs';

/** docs/DATA_ANALYSIS.md §5. Repositories for these collections come with the run orchestration tickets. */
export const RUN_METADATA_INDEXES: Readonly<Record<string, readonly IndexDescription[]>> = {
  // Paginate a run's rejects by _id range (_id > lastSeen) without skip.
  [QUARANTINE]: [{ key: { runId: 1, _id: 1 }, name: 'runId__id' }],
  // "Pending or failed batches of run R": progress, resume, retry after a worker is killed.
  [RUN_BATCHES]: [{ key: { runId: 1, status: 1 }, name: 'runId_status' }],
};

@Injectable()
export class RunMetadataIndexes implements OnModuleInit {
  constructor(@Inject(TARGET_DB) private readonly db: Db) {}

  async onModuleInit(): Promise<void> {
    for (const [name, indexes] of Object.entries(RUN_METADATA_INDEXES)) await ensureIndexes(this.db.collection(name), indexes);
  }
}

@Module({ providers: [RunMetadataIndexes] })
export class RunMetadataModule {}
