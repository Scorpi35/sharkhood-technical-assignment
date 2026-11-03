import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Db, MongoClient, ObjectId } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import pino from 'pino';
import { DEFAULT_SEED_OPTIONS, readEjsonArray, seedCollection, seedRaw } from '../../src/infra/seed/seed-raw';
import { RAW_SOURCES } from '../../src/infra/seed/raw-sources';
import { connectTestClient } from '../support/mongo';

/** Same file -> collection map as production, pointed at the trimmed fixtures. */
const FIXTURE_SOURCES = RAW_SOURCES.map((s) => ({ ...s, file: s.file.replace('data/raw/', 'test/fixtures/raw/') }));
const ROOT = resolve(__dirname, '../..');
const options = { ...DEFAULT_SEED_OPTIONS, baseDir: ROOT };
const silent = pino({ level: 'silent' });

type RawFileDoc = { _id: { $oid: string }; createdAt: { $date: string } };
const fileDocs = (file: string): RawFileDoc[] => JSON.parse(readFileSync(resolve(ROOT, file), 'utf8'));

describe('seed-raw (integration)', () => {
  let mongod: MongoMemoryServer;
  let client: MongoClient;
  let db: Db;

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    client = await connectTestClient(mongod.getUri());
  });

  beforeEach(async () => {
    db = client.db(`provider_raw_${new ObjectId().toHexString()}`);
  });

  afterAll(async () => {
    await client?.close();
    await mongod?.stop();
  });

  it('loads every fixture document, and re-seeding leaves the same state', async () => {
    const expected = FIXTURE_SOURCES.map((s) => fileDocs(s.file).length);

    const first = await seedRaw(db, silent, FIXTURE_SOURCES, options);
    expect(first.map((s) => s.count)).toEqual(expected);
    expect(first.map((s) => s.upserted)).toEqual(expected);

    const second = await seedRaw(db, silent, FIXTURE_SOURCES, options);
    expect(second.map((s) => s.count)).toEqual(expected);
    expect(second.map((s) => s.upserted)).toEqual([0, 0, 0]);
    expect(second.map((s) => s.modified)).toEqual([0, 0, 0]);
  });

  it('preserves _id as the file ObjectId and createdAt as a BSON Date', async () => {
    await seedRaw(db, silent, FIXTURE_SOURCES, options);

    for (const source of FIXTURE_SOURCES) {
      for (const fileDoc of fileDocs(source.file)) {
        const stored = await db.collection(source.collection).findOne({ _id: new ObjectId(fileDoc._id.$oid) });
        expect(stored).not.toBeNull();
        expect(stored!._id).toBeInstanceOf(ObjectId);
        expect(stored!._id.toHexString()).toBe(fileDoc._id.$oid);
        expect(stored!.createdAt).toBeInstanceOf(Date);
        expect((stored!.createdAt as Date).toISOString()).toBe(new Date(fileDoc.createdAt.$date).toISOString());
      }
    }
  });

  it('splits large inputs into several bulkWrites', async () => {
    const [menus] = FIXTURE_SOURCES.filter((s) => s.collection === 'xbyte_raw_menus');
    const stats = await seedCollection(db, menus, { ...options, chunkDocs: 1 });
    expect(stats.bulkWrites).toBe(stats.read);
  });

  describe('readEjsonArray', () => {
    let dir: string;
    beforeEach(() => (dir = mkdtempSync(join(tmpdir(), 'seed-raw-'))));
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    const drain = async (file: string): Promise<number> => {
      let n = 0;
      for await (const _ of readEjsonArray(file)) n += 1;
      return n;
    };

    it('rejects (does not hang) when the file is missing', async () => {
      await expect(drain(join(dir, 'missing.json'))).rejects.toThrow(/ENOENT/);
    });

    it('rejects malformed JSON', async () => {
      const file = join(dir, 'bad.json');
      writeFileSync(file, '[{"_id":{"$oid":"6aa77f2d2ba6464eb6cb3f4c"}}, {oops');
      await expect(drain(file)).rejects.toThrow();
    });

    it('refuses documents without an $oid _id', async () => {
      const file = join(dir, 'no-id.json');
      writeFileSync(file, '[{"domain":"talabat"}]');
      await expect(drain(file)).rejects.toThrow(/_id is missing/);
    });
  });
});
