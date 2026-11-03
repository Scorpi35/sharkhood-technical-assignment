import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { Collection, Db } from 'mongodb';
import type { RecordOf } from '../../core';
import { TARGET_DB } from '../../infra/mongo/mongo.tokens';
import { bulkUpsert, ensureIndexes, keyFilter, UpsertOutcome, versionGuard, versionString } from '../shared/versioned-upsert';
import { RESTAURANT_INDEXES, RESTAURANTS } from './restaurant.indexes';

export const RESTAURANT_REPOSITORY = Symbol('RestaurantRepository');

/** A raw collection name becomes a field name under `sources`, so it must be a plain identifier. */
const SAFE_SOURCE = /^[A-Za-z0-9_-]+$/;

/**
 * Restaurants have more than one writer (listing pages and menus) with disjoint
 * field ownership. Each writer keeps its own version under
 * `sources.<rawCollection>.version`, so a newer listing never blocks an older-but-
 * still-current menu (and vice versa), and the two converge in either order.
 * (This is the ticket's source.listingVersion / source.menuVersion, keyed by raw
 * collection so the domain needs no provider knowledge.)
 */
@Injectable()
export class RestaurantRepository implements OnModuleInit {
  private readonly collection: Collection;

  constructor(@Inject(TARGET_DB) db: Db) {
    this.collection = db.collection(RESTAURANTS);
  }

  async onModuleInit(): Promise<void> {
    await ensureIndexes(this.collection, RESTAURANT_INDEXES);
  }

  upsert(records: readonly RecordOf<'restaurant'>[]): Promise<UpsertOutcome> {
    return bulkUpsert(
      this.collection,
      records.map((r) => {
        const writer = r.source.rawCollection;
        if (!SAFE_SOURCE.test(writer)) throw new TypeError(`unsafe raw collection name for a field path: "${writer}"`);
        const version = versionString(r.version);
        const sourcePath = `sources.${writer}`;
        return {
          filter: { ...keyFilter(r.key), ...versionGuard(`${sourcePath}.version`, version) },
          update: {
            $set: {
              ...r.data,
              [sourcePath]: { provider: r.source.provider, rawId: r.version.rawId, sourceTs: r.version.sourceTs, version },
            },
          },
        };
      }),
    );
  }
}
