import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { Collection, Db } from 'mongodb';
import type { RecordOf } from '../../core';
import { TARGET_DB } from '../../infra/mongo/mongo.tokens';
import { bulkUpsert, ensureIndexes, keyFilter, UpsertOutcome, versionGuard, versionString } from '../shared/versioned-upsert';
import { AREA_INDEXES, AREAS } from './area.indexes';

export const AREA_REPOSITORY = Symbol('AreaRepository');

@Injectable()
export class AreaRepository implements OnModuleInit {
  private readonly collection: Collection;

  constructor(@Inject(TARGET_DB) db: Db) {
    this.collection = db.collection(AREAS);
  }

  async onModuleInit(): Promise<void> {
    await ensureIndexes(this.collection, AREA_INDEXES);
  }

  upsert(records: readonly RecordOf<'area'>[]): Promise<UpsertOutcome> {
    return bulkUpsert(
      this.collection,
      records.map((r) => {
        const version = versionString(r.version);
        return {
          filter: { ...keyFilter(r.key), ...versionGuard('source.version', version) },
          update: {
            $set: {
              ...r.data,
              source: { provider: r.source.provider, rawCollection: r.source.rawCollection, rawId: r.version.rawId, sourceTs: r.version.sourceTs, version },
            },
          },
        };
      }),
    );
  }
}
