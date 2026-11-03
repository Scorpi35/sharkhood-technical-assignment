import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { Collection, Db } from 'mongodb';
import type { MenuKey, RecordOf } from '../../core';
import { TARGET_DB } from '../../infra/mongo/mongo.tokens';
import { bulkUpsert, ensureIndexes, keyFilter, UpsertOutcome, versionGuard, versionString } from '../shared/versioned-upsert';
import { MENU_INDEXES, MENUS } from './menu.indexes';

export const MENU_REPOSITORY = Symbol('MenuRepository');

export const menuKeyString = (k: MenuKey): string => `${k.platform}|${k.restaurantExternalId}`;

@Injectable()
export class MenuRepository implements OnModuleInit {
  private readonly collection: Collection;

  constructor(@Inject(TARGET_DB) db: Db) {
    this.collection = db.collection(MENUS);
  }

  async onModuleInit(): Promise<void> {
    await ensureIndexes(this.collection, MENU_INDEXES);
  }

  upsert(records: readonly RecordOf<'menu'>[]): Promise<UpsertOutcome> {
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

  /** Stored snapshot version per menu key (absent keys have no menu yet). */
  async findVersions(keys: readonly MenuKey[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (keys.length === 0) return out;
    const byPlatform = new Map<string, string[]>();
    for (const k of keys) byPlatform.set(k.platform, [...(byPlatform.get(k.platform) ?? []), k.restaurantExternalId]);
    const filter = { $or: [...byPlatform].map(([platform, ids]) => ({ platform, restaurantExternalId: { $in: ids } })) };
    for await (const doc of this.collection.find(filter, { projection: { platform: 1, restaurantExternalId: 1, 'source.version': 1 } })) {
      const version = doc.source?.version;
      if (typeof version === 'string') out.set(menuKeyString(doc as unknown as MenuKey), version);
    }
    return out;
  }
}
