import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { Collection, Db } from 'mongodb';
import type { MenuKey, RecordOf } from '../../core';
import { TARGET_DB } from '../../infra/mongo/mongo.tokens';
import { bulkUpsert, ensureIndexes, keyFilter, UpsertOutcome, versionGuard, versionString } from '../shared/versioned-upsert';
import { MENU_ITEM_INDEXES, MENU_ITEMS } from './menu-item.indexes';

export const MENU_ITEM_REPOSITORY = Symbol('MenuItemRepository');

@Injectable()
export class MenuItemRepository implements OnModuleInit {
  private readonly collection: Collection;

  constructor(@Inject(TARGET_DB) db: Db) {
    this.collection = db.collection(MENU_ITEMS);
  }

  async onModuleInit(): Promise<void> {
    await ensureIndexes(this.collection, MENU_ITEM_INDEXES);
  }

  upsert(records: readonly RecordOf<'menuItem'>[]): Promise<UpsertOutcome> {
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

  /**
   * Soft-retire items that are older than their restaurant's stored menu snapshot,
   * i.e. items that disappeared from the newest menu. Never deletes (references
   * stay valid). Idempotent; returns how many items were newly retired.
   */
  async retireOlderThan(menus: readonly { key: MenuKey; menuVersion: string }[]): Promise<number> {
    if (menus.length === 0) return 0;
    const result = await this.collection.bulkWrite(
      menus.map(({ key, menuVersion }) => ({
        updateMany: {
          filter: { ...keyFilter(key), 'source.version': { $lt: menuVersion }, isAvailable: { $ne: false } },
          update: { $set: { isAvailable: false } },
        },
      })),
      { ordered: false },
    );
    return result.modifiedCount;
  }
}
