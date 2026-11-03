import { createReadStream } from 'node:fs';
import { resolve } from 'node:path';
import { pipeline } from 'node:stream';
import { AnyBulkWriteOperation, BSON, Db, Document, MongoClient, ObjectId } from 'mongodb';
import pino, { Logger } from 'pino';
import { parser } from 'stream-json';
import { streamArray } from 'stream-json/streamers/StreamArray';
import { loadConfigOrExit } from '../../config/load-config';
import { buildPinoOptions } from '../../logging/pino-options';
import { RAW_SOURCES, RawSource } from './raw-sources';

export interface SeedOptions {
  /** Max documents per bulkWrite. */
  readonly chunkDocs: number;
  /** Max approximate BSON bytes per bulkWrite. Keeps memory flat for ~27 KB menu docs. */
  readonly chunkBytes: number;
  /** Directory the source file paths are resolved against. */
  readonly baseDir: string;
}

/**
 * chunkBytes was measured: with an 8 MB cap, peak RSS grew with file size
 * (14 MB file: 156 MB, 48 MB file: 203 MB); with 2 MB it stays ~flat (146 -> 162 MB),
 * at ~100 menu docs per bulkWrite.
 */
export const DEFAULT_SEED_OPTIONS: SeedOptions = {
  chunkDocs: 500,
  chunkBytes: 2 * 1024 * 1024,
  baseDir: process.cwd(),
};

export interface SeedStats {
  readonly collection: string;
  readonly file: string;
  read: number;
  upserted: number;
  matched: number;
  modified: number;
  bulkWrites: number;
  /** Documents in the collection after the load. */
  count: number;
}

/**
 * Stream the elements of a top-level JSON array one at a time, converting each
 * from Extended JSON ($oid -> ObjectId, $date -> Date). The file is never fully
 * in memory; `pipeline` propagates read/parse errors to the iterator.
 */
export async function* readEjsonArray(file: string): AsyncGenerator<Document> {
  const elements = pipeline(createReadStream(file), parser(), streamArray(), () => {
    /* errors surface through the async iterator below */
  });
  for await (const { key, value } of elements as AsyncIterable<{ key: number; value: unknown }>) {
    const doc = BSON.EJSON.deserialize(value as Document) as Document;
    if (!(doc._id instanceof ObjectId)) {
      throw new Error(`${file}[${key}]: _id is missing or not an {$oid}; refusing to invent ids for raw data`);
    }
    yield doc;
  }
}

/**
 * Idempotently load one file into one collection: replaceOne by _id with upsert,
 * so re-seeding converges to the same state. The `_id` index exists implicitly.
 */
export async function seedCollection(
  db: Db,
  source: RawSource,
  options: SeedOptions = DEFAULT_SEED_OPTIONS,
): Promise<SeedStats> {
  const collection = db.collection(source.collection);
  const file = resolve(options.baseDir, source.file);
  const stats: SeedStats = {
    collection: source.collection,
    file: source.file,
    read: 0,
    upserted: 0,
    matched: 0,
    modified: 0,
    bulkWrites: 0,
    count: 0,
  };

  let ops: AnyBulkWriteOperation[] = [];
  let bytes = 0;
  const flush = async (): Promise<void> => {
    if (ops.length === 0) return;
    const result = await collection.bulkWrite(ops, { ordered: false });
    stats.upserted += result.upsertedCount;
    stats.matched += result.matchedCount;
    stats.modified += result.modifiedCount;
    stats.bulkWrites += 1;
    ops = [];
    bytes = 0;
  };

  for await (const doc of readEjsonArray(file)) {
    ops.push({ replaceOne: { filter: { _id: doc._id }, replacement: doc, upsert: true } });
    bytes += BSON.calculateObjectSize(doc);
    stats.read += 1;
    if (ops.length >= options.chunkDocs || bytes >= options.chunkBytes) await flush();
  }
  await flush();

  stats.count = await collection.countDocuments();
  return stats;
}

export async function seedRaw(
  db: Db,
  log: Logger,
  sources: readonly RawSource[] = RAW_SOURCES,
  options: SeedOptions = DEFAULT_SEED_OPTIONS,
): Promise<SeedStats[]> {
  const all: SeedStats[] = [];
  for (const source of sources) {
    const stats = await seedCollection(db, source, options);
    log.info(stats, 'Seeded raw collection');
    all.push(stats);
  }
  return all;
}

export async function main(): Promise<void> {
  const config = loadConfigOrExit();
  const log = pino(buildPinoOptions(config)).child({ script: 'seed-raw' });
  const client = new MongoClient(config.mongo.uri, { serverSelectionTimeoutMS: 10_000 });
  const startedAt = performance.now();
  try {
    await client.connect();
    const db = client.db(config.mongo.rawDbName);
    const stats = await seedRaw(db, log);
    log.info(
      {
        db: config.mongo.rawDbName,
        counts: Object.fromEntries(stats.map((s) => [s.collection, s.count])),
        durationMs: Math.round(performance.now() - startedAt),
        peakRssMb: Math.round(process.resourceUsage().maxRSS / 1024),
      },
      'Seed complete',
    );
  } finally {
    await client.close();
  }
}

if (require.main === module) {
  main().catch((err: unknown) => {
    const e = err instanceof Error ? err : new Error(String(err));
    process.stderr.write(
      JSON.stringify({
        level: 'fatal',
        time: new Date().toISOString(),
        msg: 'Seed failed',
        err: { message: e.message, stack: e.stack },
      }) + '\n',
    );
    process.exit(1);
  });
}
