import { Collection, Db, Filter, ObjectId } from 'mongodb';
import type { RawDocument, ScanIdsOptions, SourceReader } from '../../core';

/** Raw ids travel as hex strings; Mongo raw collections key on ObjectId. Other ids pass through. */
const toRawId = (id: string): ObjectId | string => (ObjectId.isValid(id) && /^[0-9a-f]{24}$/i.test(id) ? new ObjectId(id) : id);
const fromRawId = (id: unknown): string => (id instanceof ObjectId ? id.toHexString() : String(id));

/** Raw documents: any shape, keyed by ObjectId (or a string id for non-Mongo-born data). */
type RawDoc = { _id: ObjectId | string; [field: string]: unknown };

/**
 * SourceReader over the raw database. Read-only by construction: it only ever
 * calls find(), and exposes no write method. Cursors stream with a bounded
 * batchSize, so memory does not grow with collection size.
 */
export class MongoSourceReader implements SourceReader {
  constructor(
    private readonly rawDb: Db,
    private readonly cursorBatchSize = 500,
  ) {}

  private raw(collection: string): Collection<RawDoc> {
    return this.rawDb.collection<RawDoc>(collection);
  }

  async *scanIds(collection: string, { afterId, limit }: ScanIdsOptions): AsyncIterable<string[]> {
    if (!Number.isInteger(limit) || limit < 1) throw new RangeError(`scanIds: limit must be a positive integer, got ${limit}`);
    const filter: Filter<RawDoc> = afterId === undefined ? {} : { _id: { $gt: toRawId(afterId) } };
    const cursor = this.raw(collection)
      .find(filter, { projection: { _id: 1 } })
      .sort({ _id: 1 })
      .batchSize(Math.max(limit, 1));
    let page: string[] = [];
    try {
      for await (const doc of cursor) {
        page.push(fromRawId(doc._id));
        if (page.length === limit) {
          yield page;
          page = [];
        }
      }
      if (page.length > 0) yield page;
    } finally {
      await cursor.close();
    }
  }

  async *readRange(collection: string, fromId: string, toId: string): AsyncIterable<RawDocument> {
    const cursor = this.raw(collection)
      .find({ _id: { $gte: toRawId(fromId), $lte: toRawId(toId) } })
      .sort({ _id: 1 })
      .batchSize(this.cursorBatchSize);
    try {
      for await (const doc of cursor) {
        yield {
          id: fromRawId(doc._id),
          collection,
          // A missing/invalid createdAt becomes an Invalid Date, which the pipeline quarantines.
          sourceTs: doc.createdAt instanceof Date ? doc.createdAt : new Date(Number.NaN),
          body: doc,
        };
      }
    } finally {
      await cursor.close();
    }
  }
}
