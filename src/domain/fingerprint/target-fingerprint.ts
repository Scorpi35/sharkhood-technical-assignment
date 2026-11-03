import { createHash } from 'node:crypto';
import { Db, IndexDescription, MongoClient } from 'mongodb';
import { stableStringify } from '../../core';
import { loadConfigOrExit } from '../../config/load-config';
import { AREA_INDEXES, AREAS } from '../area/area.indexes';
import { MENU_ITEM_INDEXES, MENU_ITEMS } from '../menu-item/menu-item.indexes';
import { MENU_INDEXES, MENUS } from '../menu/menu.indexes';
import { RESTAURANT_AREA_INDEXES, RESTAURANT_AREAS } from '../restaurant-area/restaurant-area.indexes';
import { RESTAURANT_INDEXES, RESTAURANTS } from '../restaurant/restaurant.indexes';

/** Every target collection, with the natural key (its unique index) to sort by. Run metadata is excluded. */
const TARGETS: readonly [string, readonly IndexDescription[]][] = [
  [AREAS, AREA_INDEXES],
  [RESTAURANTS, RESTAURANT_INDEXES],
  [RESTAURANT_AREAS, RESTAURANT_AREA_INDEXES],
  [MENUS, MENU_INDEXES],
  [MENU_ITEMS, MENU_ITEM_INDEXES],
];

export interface CollectionFingerprint {
  readonly count: number;
  readonly sha256: string;
}

const naturalKeyOf = (indexes: readonly IndexDescription[]): Record<string, 1> => {
  const unique = indexes.find((i) => i.unique);
  if (!unique || unique.key instanceof Map) throw new Error('every target collection needs a unique natural-key index');
  return Object.fromEntries(Object.keys(unique.key).map((k) => [k, 1 as const]));
};

/**
 * A content hash per target collection: documents streamed in natural-key order,
 * `_id` dropped (store-assigned, so it differs between databases), each
 * stable-stringified (sorted keys, ISO dates) and fed to sha256. Two databases
 * with the same logical content get the same hashes, whatever order the
 * documents and their fields were written in.
 */
export async function fingerprintTarget(db: Db): Promise<Record<string, CollectionFingerprint>> {
  const out: Record<string, CollectionFingerprint> = {};
  for (const [name, indexes] of TARGETS) {
    const hash = createHash('sha256');
    let count = 0;
    const cursor = db.collection(name).find({}, { projection: { _id: 0 } }).sort(naturalKeyOf(indexes)).batchSize(1000);
    for await (const doc of cursor) {
      hash.update(stableStringify(doc));
      hash.update('\n');
      count += 1;
    }
    out[name] = { count, sha256: hash.digest('hex') };
  }
  return out;
}

/** CLI: print the fingerprint of the configured target database as JSON. */
export async function main(): Promise<void> {
  const config = loadConfigOrExit();
  const client = new MongoClient(config.mongo.uri, { serverSelectionTimeoutMS: 10_000 });
  try {
    await client.connect();
    const fingerprint = await fingerprintTarget(client.db(config.mongo.targetDbName));
    process.stdout.write(JSON.stringify({ db: config.mongo.targetDbName, fingerprint }, null, 2) + '\n');
  } finally {
    await client.close();
  }
}

if (require.main === module) {
  main().catch((err: unknown) => {
    process.stderr.write(JSON.stringify({ level: 'fatal', msg: 'Fingerprint failed', err: String(err) }) + '\n');
    process.exit(1);
  });
}
