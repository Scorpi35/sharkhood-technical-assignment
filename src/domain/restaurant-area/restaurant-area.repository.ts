import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { Collection, Db } from 'mongodb';
import type { RecordOf } from '../../core';
import { TARGET_DB } from '../../infra/mongo/mongo.tokens';
import { bulkUpsert, ensureIndexes, keyFilter, UpsertOutcome } from '../shared/versioned-upsert';
import { RESTAURANT_AREA_INDEXES, RESTAURANT_AREAS } from './restaurant-area.indexes';

export const RESTAURANT_AREA_REPOSITORY = Symbol('RestaurantAreaRepository');

/**
 * Coverage edges are a union of observations: $min firstSeenAt, $max lastSeenAt
 * (both from sourceTs) and $addToSet of the writing source. All three operators
 * are commutative and idempotent, so no version guard is needed and the result
 * does not depend on batch order. Never "stale".
 */
@Injectable()
export class RestaurantAreaRepository implements OnModuleInit {
  private readonly collection: Collection;

  constructor(@Inject(TARGET_DB) db: Db) {
    this.collection = db.collection(RESTAURANT_AREAS);
  }

  async onModuleInit(): Promise<void> {
    await ensureIndexes(this.collection, RESTAURANT_AREA_INDEXES);
  }

  upsert(records: readonly RecordOf<'restaurantArea'>[]): Promise<UpsertOutcome> {
    return bulkUpsert(
      this.collection,
      records.map((r) => ({
        filter: keyFilter(r.key),
        update: {
          $min: { firstSeenAt: r.version.sourceTs },
          $max: { lastSeenAt: r.version.sourceTs },
          $addToSet: { sources: { provider: r.source.provider, rawCollection: r.source.rawCollection } },
        },
      })),
    );
  }
}
