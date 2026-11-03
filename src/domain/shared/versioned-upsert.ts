import { BulkWriteResult, Collection, Document, Filter, IndexDescription, MongoBulkWriteError, UpdateFilter } from 'mongodb';
import type { RecordVersion } from '../../core';

/**
 * Sortable version string: ISO timestamp (fixed width, so lexicographic order is
 * time order) then rawId. The same total order as core's compareVersions.
 */
export const versionString = (v: RecordVersion): string => `${v.sourceTs.toISOString()}|${v.rawId}`;

/**
 * Match only when the stored version is <= the incoming one (or absent).
 * - newer incoming: matches, $set applies -> written
 * - equal (same raw doc re-applied): matches, $set is a no-op -> unchanged
 * - older incoming: no match, so the upsert tries an insert and hits the unique
 *   natural-key index (E11000) -> stale
 * `$lte`, not `$lt`: with `$lt` a re-run would count every record as stale.
 */
export const versionGuard = (path: string, version: string): Filter<Document> => ({
  $or: [{ [path]: { $lte: version } }, { [path]: { $exists: false } }],
});

export interface UpsertOp {
  readonly filter: Filter<Document>;
  readonly update: UpdateFilter<Document>;
}

export interface UpsertOutcome {
  readonly written: number;
  readonly unchanged: number;
  readonly stale: number;
  /** Per input op: true if it was applied (written or unchanged), false if stale. */
  readonly applied: readonly boolean[];
}

export const EMPTY_OUTCOME: UpsertOutcome = { written: 0, unchanged: 0, stale: 0, applied: [] };

const DUPLICATE_KEY = 11000;

/**
 * Unordered bulk of upserting updateOnes.
 *
 * E11000 handling: a duplicate-key error means "the document exists and the
 * guard did not match", i.e. stale. But two concurrent upserts of a brand-new
 * key race to insert, and the loser also gets E11000, even if its version is
 * newer. So E11000 ops are retried once: by then the document exists and the
 * version guard decides. A second E11000 is a genuine stale.
 * Any other write error is infrastructure: it is thrown (BullMQ retries the batch).
 */
export async function bulkUpsert(collection: Collection, ops: readonly UpsertOp[]): Promise<UpsertOutcome> {
  if (ops.length === 0) return EMPTY_OUTCOME;

  const first = await runBulk(collection, ops);
  if (first.duplicates.length === 0) {
    return { written: first.written, unchanged: first.unchanged, stale: 0, applied: ops.map(() => true) };
  }

  const retry = await runBulk(
    collection,
    first.duplicates.map((i) => ops[i]),
  );
  const stale = new Set(retry.duplicates.map((j) => first.duplicates[j]));
  return {
    written: first.written + retry.written,
    unchanged: first.unchanged + retry.unchanged,
    stale: stale.size,
    applied: ops.map((_, i) => !stale.has(i)),
  };
}

interface BulkRound {
  readonly written: number;
  readonly unchanged: number;
  /** Indexes (into this round's ops) that failed with E11000. */
  readonly duplicates: number[];
}

async function runBulk(collection: Collection, ops: readonly UpsertOp[]): Promise<BulkRound> {
  const models = ops.map((op) => ({ updateOne: { filter: op.filter, update: op.update, upsert: true } }));
  try {
    return tally(await collection.bulkWrite(models, { ordered: false }), []);
  } catch (err) {
    if (!(err instanceof MongoBulkWriteError)) throw err;
    const errors = Array.isArray(err.writeErrors) ? err.writeErrors : [err.writeErrors];
    if (errors.length === 0 || errors.some((e) => e.code !== DUPLICATE_KEY)) throw err;
    return tally(err.result, errors.map((e) => e.index));
  }
}

const tally = (r: BulkWriteResult, duplicates: number[]): BulkRound => ({
  written: r.upsertedCount + r.modifiedCount,
  unchanged: r.matchedCount - r.modifiedCount,
  duplicates,
});

/** createIndexes is idempotent for identical specs; a conflicting spec fails startup loudly. */
export async function ensureIndexes(collection: Collection, indexes: readonly IndexDescription[]): Promise<void> {
  if (indexes.length > 0) await collection.createIndexes([...indexes]);
}

/** Natural-key equality filter from a record key. */
export const keyFilter = (key: object): Filter<Document> => ({ ...key });
