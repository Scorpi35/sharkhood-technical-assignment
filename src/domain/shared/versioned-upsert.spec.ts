import { Collection, MongoBulkWriteError } from 'mongodb';
import { bulkUpsert, UpsertOp, versionString } from './versioned-upsert';

/** A MongoBulkWriteError as the driver throws it for an unordered bulk (constructed without the driver's private ctor). */
function bulkError(writeErrors: { index: number; code: number }[], counts = { upsertedCount: 0, matchedCount: 0, modifiedCount: 0 }) {
  return Object.assign(Object.create(MongoBulkWriteError.prototype), { writeErrors, result: counts, message: 'bulk failed' });
}

/** Fake collection: each bulkWrite call returns/throws the next scripted response. */
function fakeCollection(responses: (() => unknown)[]) {
  const calls: number[] = [];
  const collection = {
    bulkWrite: async (models: unknown[]) => {
      calls.push(models.length);
      return responses.shift()!();
    },
  } as unknown as Collection;
  return { collection, calls };
}

const op = (n: number): UpsertOp => ({ filter: { k: n }, update: { $set: { n } } });
const ok = (upsertedCount: number, matchedCount: number, modifiedCount: number) => () => ({ upsertedCount, matchedCount, modifiedCount });

describe('bulkUpsert', () => {
  it('retries an E11000 once: a racing insert that lost but is newer still gets applied', async () => {
    // Round 1: op 1 loses an insert race (E11000). Round 2 (retry of op 1 only): the guard matches, it updates.
    const { collection, calls } = fakeCollection([
      () => {
        throw bulkError([{ index: 1, code: 11000 }], { upsertedCount: 2, matchedCount: 0, modifiedCount: 0 });
      },
      ok(0, 1, 1),
    ]);
    const out = await bulkUpsert(collection, [op(0), op(1), op(2)]);
    expect(calls).toEqual([3, 1]);
    expect(out).toEqual({ written: 3, unchanged: 0, stale: 0, applied: [true, true, true] });
  });

  it('counts an op as stale only when the retry hits E11000 again', async () => {
    const { collection } = fakeCollection([
      () => {
        throw bulkError([{ index: 0, code: 11000 }], { upsertedCount: 0, matchedCount: 1, modifiedCount: 0 });
      },
      () => {
        throw bulkError([{ index: 0, code: 11000 }]);
      },
    ]);
    expect(await bulkUpsert(collection, [op(0), op(1)])).toEqual({ written: 0, unchanged: 1, stale: 1, applied: [false, true] });
  });

  it('rethrows any non-duplicate write error (infrastructure: the batch is retried)', async () => {
    const { collection } = fakeCollection([
      () => {
        throw bulkError([
          { index: 0, code: 11000 },
          { index: 1, code: 121 }, // document validation failure
        ]);
      },
    ]);
    await expect(bulkUpsert(collection, [op(0), op(1)])).rejects.toThrow('bulk failed');
  });

  it('versions sort like the core total order (sourceTs, then rawId)', () => {
    const v = (iso: string, rawId: string) => versionString({ sourceTs: new Date(iso), rawId });
    expect(v('2026-07-22T08:00:00Z', 'f'.repeat(24)) < v('2026-09-14T04:59:25Z', '0'.repeat(24))).toBe(true);
    expect(v('2026-09-14T04:59:25Z', 'a'.repeat(24)) < v('2026-09-14T04:59:25Z', 'b'.repeat(24))).toBe(true);
  });
});
