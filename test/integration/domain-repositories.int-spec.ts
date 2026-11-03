import type { INestApplicationContext } from '@nestjs/common';
import { Db, Document, IndexDescription, ObjectId } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { DomainRecord, RawDocument, RecordOf, runPipeline, TARGET_WRITER, TargetWriter } from '../../src/core';
import { AREA_INDEXES, AREAS } from '../../src/domain/area/area.indexes';
import { MENU_ITEM_INDEXES, MENU_ITEMS } from '../../src/domain/menu-item/menu-item.indexes';
import { MENU_INDEXES, MENUS } from '../../src/domain/menu/menu.indexes';
import { RESTAURANT_AREA_INDEXES, RESTAURANT_AREAS } from '../../src/domain/restaurant-area/restaurant-area.indexes';
import { RESTAURANT_INDEXES, RESTAURANTS } from '../../src/domain/restaurant/restaurant.indexes';
import { RUN_METADATA_INDEXES } from '../../src/domain/run-metadata/run-metadata.indexes';
import { TARGET_DB } from '../../src/infra/mongo/mongo.tokens';
import { RAW_COLLECTIONS } from '../../src/providers/xbyte/mappings';
import { createXbyteAdapter } from '../../src/providers/xbyte/xbyte.adapter';
import { loadFixtureDocs, loadRawFixtures } from '../support/fixtures';
import { bootDomain } from '../support/nest';

const adapter = createXbyteAdapter();
const recordsOf = (docs: RawDocument[]): DomainRecord[] => runPipeline(docs, adapter).records;
const of = <E extends DomainRecord['entity']>(records: DomainRecord[], e: E) => records.filter((r): r is RecordOf<E> => r.entity === e);
const allFixtureRecords = () =>
  recordsOf([
    ...loadRawFixtures('xbyte/locations.json', RAW_COLLECTIONS.locations),
    ...loadRawFixtures('xbyte/restaurants.json', RAW_COLLECTIONS.restaurants),
    ...loadRawFixtures('xbyte/menus.json', RAW_COLLECTIONS.menus),
  ]);
/** A target document without its store-assigned _id, for order-independence comparisons. */
const strip = ({ _id, ...rest }: Document) => rest;

describe('domain repositories (integration)', () => {
  let mongod: MongoMemoryServer;
  let app: INestApplicationContext;
  let writer: TargetWriter;
  let db: Db;

  const boot = async () => {
    const ctx = await bootDomain(mongod.getUri(), `target_${new ObjectId().toHexString()}`);
    return { ctx, writer: ctx.get<TargetWriter>(TARGET_WRITER), db: ctx.get<Db>(TARGET_DB) };
  };

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
  });
  beforeEach(async () => {
    ({ ctx: app, writer, db } = await boot());
  });
  afterEach(async () => {
    await app?.close();
  });
  afterAll(async () => {
    await mongod?.stop();
  });

  it('upserting the same records twice: the second call is written=0, unchanged=N', async () => {
    const records = allFixtureRecords();
    const first = await writer.upsert(records);
    expect(first).toMatchObject({ written: records.length, unchanged: 0, stale: 0 });

    const second = await writer.upsert(records);
    expect(second).toMatchObject({ written: 0, unchanged: records.length, stale: 0, retired: 0 });
  });

  it('upserting v2 then v1: the final doc holds v2, and v1 is counted as stale', async () => {
    const [area] = of(allFixtureRecords(), 'area');
    const v1: DomainRecord = { ...area, data: { ...area.data, name: 'Old name' }, version: { sourceTs: new Date('2026-01-01T00:00:00Z'), rawId: 'a'.repeat(24) } };
    const v2: DomainRecord = { ...area, data: { ...area.data, name: 'New name' }, version: { sourceTs: new Date('2026-02-01T00:00:00Z'), rawId: 'b'.repeat(24) } };

    expect(await writer.upsert([v2])).toMatchObject({ written: 1, stale: 0 });
    expect(await writer.upsert([v1])).toMatchObject({ written: 0, unchanged: 0, stale: 1 });

    const doc = await db.collection(AREAS).findOne(area.key);
    expect(doc).toMatchObject({ name: 'New name', source: { version: `2026-02-01T00:00:00.000Z|${'b'.repeat(24)}`, rawId: 'b'.repeat(24) } });
  });

  it('listing and menu writes to the same restaurant, in either order, give the same final doc', async () => {
    const records = allFixtureRecords();
    const listing = of(records, 'restaurant').find((r) => r.source.rawCollection === RAW_COLLECTIONS.restaurants)!;
    const menu = of(records, 'restaurant').find((r) => r.source.rawCollection === RAW_COLLECTIONS.menus)!;
    // Constructed: the sample has zero listing/menu overlap, so give both the same key.
    const menuForSameRestaurant: DomainRecord = { ...menu, key: listing.key };

    await writer.upsert([listing]);
    await writer.upsert([menuForSameRestaurant]);
    const listingFirst = await db.collection(RESTAURANTS).findOne(listing.key);

    const other = await boot();
    try {
      await other.writer.upsert([menuForSameRestaurant]);
      await other.writer.upsert([listing]);
      const menuFirst = await other.db.collection(RESTAURANTS).findOne(listing.key);
      expect(strip(menuFirst!)).toEqual(strip(listingFirst!));
    } finally {
      await other.ctx.close();
    }

    // Both owners' fields are present, each with its own version.
    expect(listingFirst).toMatchObject({ listing: listing.data.listing, name: menu.data.name, vendorId: menu.data.vendorId });
    expect(Object.keys(listingFirst!.sources).sort()).toEqual([RAW_COLLECTIONS.menus, RAW_COLLECTIONS.restaurants].sort());
  });

  it('a newer listing does not block an older menu (separate per-writer versions)', async () => {
    const records = allFixtureRecords();
    const listing = of(records, 'restaurant').find((r) => r.source.rawCollection === RAW_COLLECTIONS.restaurants)!;
    const menu = { ...of(records, 'restaurant').find((r) => r.source.rawCollection === RAW_COLLECTIONS.menus)!, key: listing.key };
    expect(menu.version.sourceTs.getTime()).toBeLessThan(listing.version.sourceTs.getTime()); // menus were scraped 54 days earlier

    await writer.upsert([listing]);
    expect(await writer.upsert([menu])).toMatchObject({ written: 1, stale: 0 });
  });

  it('restaurant_areas: firstSeenAt/lastSeenAt are the min/max sourceTs, in any order, never stale', async () => {
    const [edge] = of(allFixtureRecords(), 'restaurantArea');
    const at = (iso: string, rawId: string): DomainRecord => ({ ...edge, version: { sourceTs: new Date(iso), rawId } });
    const observations = [at('2026-03-01T00:00:00Z', 'c'.repeat(24)), at('2026-01-01T00:00:00Z', 'a'.repeat(24)), at('2026-02-01T00:00:00Z', 'b'.repeat(24))];

    for (const o of observations) expect(await writer.upsert([o])).toMatchObject({ stale: 0 });
    const doc = await db.collection(RESTAURANT_AREAS).findOne(edge.key);
    expect(doc).toMatchObject({ firstSeenAt: new Date('2026-01-01T00:00:00Z'), lastSeenAt: new Date('2026-03-01T00:00:00Z') });
    expect(doc!.sources).toEqual([{ provider: 'xbyte', rawCollection: RAW_COLLECTIONS.restaurants }]);
  });

  it('menu snapshots: an item dropped from the newer snapshot is retired, and the result is the same in either order', async () => {
    // Constructed: the collision menu (v1), and a later snapshot of it without its first item (v2).
    const v1Doc = loadFixtureDocs('xbyte/menus.json')[1];
    const dropped = String(v1Doc.payload.results[0].category[0].items[0].item_id);
    const v2Doc = loadFixtureDocs('xbyte/menus.json')[1];
    for (const c of v2Doc.payload.results[0].category) c.items = c.items.filter((i: Document) => String(i.item_id) !== dropped);
    const raw = (doc: Document, id: string, ts: string): RawDocument => ({ id, collection: RAW_COLLECTIONS.menus, sourceTs: new Date(ts), body: { ...doc, createdAt: new Date(ts) } });
    const v1 = recordsOf([raw(v1Doc, '1'.repeat(24), '2026-07-22T08:00:00Z')]);
    const v2 = recordsOf([raw(v2Doc, '2'.repeat(24), '2026-08-22T08:00:00Z')]);

    const finalState = async (w: TargetWriter, d: Db) => {
      const items = await d.collection(MENU_ITEMS).find({}, { projection: { _id: 0 } }).sort({ itemId: 1 }).toArray();
      const menu = await d.collection(MENUS).findOne({}, { projection: { _id: 0 } });
      return { items, menu };
    };

    await writer.upsert(v1);
    const result = await writer.upsert(v2);
    expect(result.retired).toBe(1);
    const inOrder = await finalState(writer, db);
    expect(inOrder.items.find((i) => i.itemId === dropped)).toMatchObject({ isAvailable: false });
    expect(inOrder.items.filter((i) => i.itemId !== dropped).every((i) => i.isAvailable === true)).toBe(true);

    const other = await boot();
    try {
      await other.writer.upsert(v2);
      const late = await other.writer.upsert(v1); // older snapshot arrives late
      expect(late.byEntity?.menu).toMatchObject({ stale: 1 });
      const reversed = await finalState(other.writer, other.db);
      expect(reversed).toEqual(inOrder);
      // and replaying the late batch again changes nothing
      expect(await other.writer.upsert(v1)).toMatchObject({ written: 0, retired: 0 });
    } finally {
      await other.ctx.close();
    }
  });

  it('concurrent upserts of a brand-new key converge on the newest version', async () => {
    const [area] = of(allFixtureRecords(), 'area');
    for (let round = 0; round < 5; round++) {
      const key = { ...area.key, externalId: `race-${round}` };
      const versions = Array.from({ length: 20 }, (_, i) => ({
        ...area,
        key,
        data: { ...area.data, name: `v${i}` },
        version: { sourceTs: new Date(Date.UTC(2026, 0, 1, 0, 0, i)), rawId: String(i).padStart(24, '0') },
      }));
      const results = await Promise.all(versions.map((v) => writer.upsert([v])));
      const doc = await db.collection(AREAS).findOne(key);
      expect(doc?.name).toBe('v19');
      expect(results.reduce((n, r) => n + r.written + r.stale, 0)).toBe(20);
      expect(await db.collection(AREAS).countDocuments(key)).toBe(1);
    }
  });

  it('accepts restaurants with geo: null under the 2dsphere index', async () => {
    const menu = of(allFixtureRecords(), 'restaurant').find((r) => r.source.rawCollection === RAW_COLLECTIONS.menus)!;
    const noGeo: DomainRecord = { ...menu, data: { ...menu.data, geo: null } };
    expect(await writer.upsert([noGeo])).toMatchObject({ written: 1 });
  });

  it('all unique and secondary indexes exist after boot', async () => {
    const expected: Record<string, readonly IndexDescription[]> = {
      [AREAS]: AREA_INDEXES,
      [RESTAURANTS]: RESTAURANT_INDEXES,
      [RESTAURANT_AREAS]: RESTAURANT_AREA_INDEXES,
      [MENUS]: MENU_INDEXES,
      [MENU_ITEMS]: MENU_ITEM_INDEXES,
      ...RUN_METADATA_INDEXES,
    };
    for (const [collection, specs] of Object.entries(expected)) {
      const actual = (await db.collection(collection).listIndexes().toArray()).map((i) => ({ key: i.key, unique: i.unique === true }));
      for (const spec of specs) expect(actual).toContainEqual({ key: spec.key, unique: spec.unique === true });
      expect(actual).toHaveLength(specs.length + 1); // + the implicit _id index; nothing extra
    }
  });

  it('booting twice is idempotent (createIndexes on existing indexes is a no-op)', async () => {
    const second = await bootDomain(mongod.getUri(), db.databaseName);
    await second.close();
  });
});
