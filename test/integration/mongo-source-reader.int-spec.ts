import type { INestApplicationContext } from '@nestjs/common';
import { resolve } from 'node:path';
import { Db, MongoClient, ObjectId } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import pino from 'pino';
import { RawDocument, runPipeline, TARGET_WRITER, TargetWriter } from '../../src/core';
import { MENU_ITEMS } from '../../src/domain/menu-item/menu-item.indexes';
import { MongoSourceReader } from '../../src/infra/mongo/mongo-source-reader';
import { TARGET_DB } from '../../src/infra/mongo/mongo.tokens';
import { RAW_SOURCES } from '../../src/infra/seed/raw-sources';
import { DEFAULT_SEED_OPTIONS, seedRaw } from '../../src/infra/seed/seed-raw';
import { createXbyteAdapter } from '../../src/providers/xbyte/xbyte.adapter';
import { connectTestClient } from '../support/mongo';
import { bootDomain } from '../support/nest';

const ROOT = resolve(__dirname, '../..');
const silent = pino({ level: 'silent' });
const collect = async <T>(it: AsyncIterable<T>): Promise<T[]> => {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
};

describe('MongoSourceReader (integration)', () => {
  let mongod: MongoMemoryServer;
  let client: MongoClient;
  let raw: Db;
  let reader: MongoSourceReader;

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    client = await connectTestClient(mongod.getUri());
    raw = client.db(`raw_${new ObjectId().toHexString()}`);
    await seedRaw(raw, silent, RAW_SOURCES, { ...DEFAULT_SEED_OPTIONS, baseDir: ROOT }); // the full 8 / 70 / 500 sample
    reader = new MongoSourceReader(raw);
  });
  afterAll(async () => {
    await client?.close();
    await mongod?.stop();
  });

  it('scanIds pages ascending ids of at most `limit`, and resumes after `afterId`', async () => {
    const pages = await collect(reader.scanIds('xbyte_raw_restaurants', { limit: 30 }));
    expect(pages.map((p) => p.length)).toEqual([30, 30, 10]);
    const ids = pages.flat();
    expect(ids).toEqual([...ids].sort());
    expect(new Set(ids).size).toBe(70);

    const resumed = (await collect(reader.scanIds('xbyte_raw_restaurants', { afterId: ids[29], limit: 100 }))).flat();
    expect(resumed).toEqual(ids.slice(30));
  });

  it('readRange is inclusive on both ends, ordered, and maps to RawDocument', async () => {
    const ids = (await collect(reader.scanIds('xbyte_raw_menus', { limit: 500 }))).flat();
    const docs = await collect(reader.readRange('xbyte_raw_menus', ids[10], ids[34]));
    expect(docs.map((d) => d.id)).toEqual(ids.slice(10, 35));
    const [first] = docs;
    expect(first).toMatchObject({ id: ids[10], collection: 'xbyte_raw_menus' });
    expect(first.sourceTs).toBeInstanceOf(Date);
    expect(first.sourceTs).toEqual((first.body as { createdAt: Date }).createdAt);
  });

  it('is read-only by construction: no method besides scanIds and readRange', () => {
    const methods = Object.getOwnPropertyNames(MongoSourceReader.prototype).filter((m) => m !== 'constructor');
    expect(methods.sort()).toEqual(['raw', 'readRange', 'scanIds']); // `raw` is a private collection accessor
  });

  describe('full sample through pipeline and writer', () => {
    let app: INestApplicationContext;
    beforeAll(async () => {
      app = await bootDomain(mongod.getUri(), `target_${new ObjectId().toHexString()}`);
    });
    afterAll(async () => app?.close());

    /** What a worker will do: read every range, run the pipeline per batch, write. */
    const migrate = async (writer: TargetWriter) => {
      const adapter = createXbyteAdapter({ batchSizeDefault: 200, batchSizeMenus: 25 });
      const totals = { written: 0, unchanged: 0, stale: 0, retired: 0, records: 0 };
      for (const handler of adapter.sources) {
        for await (const page of reader.scanIds(handler.rawCollection, { limit: handler.batchSize ?? 200 })) {
          const docs: RawDocument[] = await collect(reader.readRange(handler.rawCollection, page[0], page[page.length - 1]));
          const { records } = runPipeline(docs, adapter);
          const r = await writer.upsert(records);
          totals.written += r.written;
          totals.unchanged += r.unchanged;
          totals.stale += r.stale;
          totals.retired += r.retired ?? 0;
          totals.records += records.length;
        }
      }
      return totals;
    };

    it('second full migration writes nothing; collection counts match the analysis', async () => {
      const writer = app.get<TargetWriter>(TARGET_WRITER);
      const first = await migrate(writer);
      expect(first.written).toBeGreaterThan(0);

      const second = await migrate(writer);
      expect(second).toEqual({ written: 0, unchanged: first.records, stale: 0, retired: 0, records: first.records });

      const target = app.get<Db>(TARGET_DB);
      const counts = Object.fromEntries(
        await Promise.all(['areas', 'restaurants', 'restaurant_areas', 'menus', MENU_ITEMS].map(async (c) => [c, await target.collection(c).countDocuments()])),
      );
      expect(counts).toEqual({ areas: 697, restaurants: 647, restaurant_areas: 463, menus: 345, menu_items: 28773 });
    });
  });
});
