import { Inject, Injectable } from '@nestjs/common';
import { Collection, Db, Filter, ObjectId } from 'mongodb';
import {
  InvalidCursorError,
  QUARANTINE_REASONS,
  QuarantineEntry,
  QuarantinePage,
  QuarantineQuery,
  QuarantineReason,
  QuarantineRepository,
  StoredQuarantineEntry,
} from '../../core';
import { TARGET_DB } from '../../infra/mongo/mongo.tokens';
import { bulkUpsert } from '../shared/versioned-upsert';
import { QUARANTINE } from './run-metadata.indexes';

/** `path` is stored as null when absent, so the unique identity treats "no path" as one value. */
type QuarantineDoc = Omit<QuarantineEntry, 'path'> & { _id: ObjectId; path: string | null };

@Injectable()
export class MongoQuarantineRepository implements QuarantineRepository {
  private readonly collection: Collection<QuarantineDoc>;

  constructor(@Inject(TARGET_DB) db: Db) {
    this.collection = db.collection<QuarantineDoc>(QUARANTINE);
  }

  async add(entries: readonly QuarantineEntry[]): Promise<number> {
    const out = await bulkUpsert(
      this.collection as unknown as Collection,
      entries.map((e) => {
        const path = e.path ?? null;
        return {
          filter: { runId: e.runId, rawCollection: e.rawCollection, sourceId: e.sourceId, reason: e.reason, path },
          // First occurrence wins; a retry's identical entry changes nothing.
          update: { $setOnInsert: stripUndefined({ ...e, path }) },
        };
      }),
    );
    return out.written;
  }

  async list(runId: string, q: QuarantineQuery): Promise<QuarantinePage> {
    if (q.cursor !== undefined && !ObjectId.isValid(q.cursor)) throw new InvalidCursorError(`invalid cursor "${q.cursor}"`);
    const filter: Filter<QuarantineDoc> = {
      runId,
      ...(q.reason === undefined ? {} : { reason: q.reason }),
      ...(q.severity === undefined ? {} : { severity: q.severity }),
      ...(q.cursor === undefined ? {} : { _id: { $gt: new ObjectId(q.cursor) } }),
    };
    const docs = await this.collection.find(filter).sort({ _id: 1 }).limit(q.limit + 1).toArray();
    const page = docs.slice(0, q.limit).map(({ _id, path, ...rest }): StoredQuarantineEntry => ({
      id: _id.toHexString(),
      ...rest,
      ...(path === null ? {} : { path }),
    }));
    return docs.length > q.limit ? { entries: page, nextCursor: page[page.length - 1].id } : { entries: page };
  }

  async countByReason(runId: string): Promise<Record<QuarantineReason, number>> {
    const out = Object.fromEntries(QUARANTINE_REASONS.map((r) => [r, 0])) as Record<QuarantineReason, number>;
    const rows = await this.collection
      .aggregate<{ _id: QuarantineReason; n: number }>([{ $match: { runId } }, { $group: { _id: '$reason', n: { $sum: 1 } } }])
      .toArray();
    for (const { _id, n } of rows) out[_id] = n;
    return out;
  }
}

const stripUndefined = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
