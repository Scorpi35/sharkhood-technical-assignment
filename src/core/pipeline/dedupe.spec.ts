import { compareVersions, dedupe } from './dedupe';
import { stableStringify } from './stable-stringify';
import { areaIdOf, areaRecord, seededRandom, shuffle } from './test-helpers';

describe('dedupe', () => {
  // Same area key (externalId 1) seen in several raw docs, plus unrelated keys.
  const records = [
    areaRecord(1, 'aaa', '2026-01-01T00:00:00Z', 'oldest'),
    areaRecord(1, 'ccc', '2026-03-01T00:00:00Z', 'newest, lower rawId'),
    areaRecord(1, 'ddd', '2026-03-01T00:00:00Z', 'newest, highest rawId'), // winner: max (sourceTs, rawId)
    areaRecord(1, 'bbb', '2026-02-01T00:00:00Z', 'middle'),
    areaRecord(2, 'aaa', '2026-01-01T00:00:00Z'),
    areaRecord(2, 'zzz', '2025-12-31T00:00:00Z'), // newer sourceTs beats higher rawId
    areaRecord(3, 'eee', '2026-01-01T00:00:00Z'),
  ];

  const winnersOf = (input: typeof records) =>
    dedupe(input)
      .winners.map((r) => `${areaIdOf(r)}:${r.version.rawId}`)
      .sort();

  it('keeps the record with the max (sourceTs, rawId) per key', () => {
    const { winners, deduplicated } = dedupe(records);
    expect(winnersOf(records)).toEqual(['1:ddd', '2:aaa', '3:eee']);
    expect(winners.find((r) => areaIdOf(r) === 1)?.data).toMatchObject({ name: 'newest, highest rawId' });
    expect(deduplicated).toBe(4);
  });

  it('picks the same winners for 10 shuffles of the input', () => {
    const expected = winnersOf(records);
    const rand = seededRandom(20261103);
    for (let i = 0; i < 10; i++) {
      expect(winnersOf(shuffle(records, rand))).toEqual(expected);
    }
  });

  it('breaks an exact version tie on data, so even duplicates are order-independent', () => {
    const a = areaRecord(9, 'same', '2026-01-01T00:00:00Z', 'Alpha');
    const b = areaRecord(9, 'same', '2026-01-01T00:00:00Z', 'Beta');
    expect(dedupe([a, b]).winners[0].data).toEqual(dedupe([b, a]).winners[0].data);
  });

  it('groups by key value, not by key property order', () => {
    const a = areaRecord(5, 'x', '2026-01-01T00:00:00Z');
    const reordered = { ...a, key: { externalId: '5', platform: 'p' }, version: { ...a.version, rawId: 'y' } };
    expect(dedupe([a, reordered]).winners).toHaveLength(1);
  });

  it('orders versions totally: sourceTs first, then rawId', () => {
    const v = (ts: string, rawId: string) => ({ sourceTs: new Date(ts), rawId });
    expect(compareVersions(v('2026-01-02', 'a'), v('2026-01-01', 'z'))).toBeGreaterThan(0);
    expect(compareVersions(v('2026-01-01', 'b'), v('2026-01-01', 'a'))).toBeGreaterThan(0);
    expect(compareVersions(v('2026-01-01', 'a'), v('2026-01-01', 'a'))).toBe(0);
  });
});

describe('stableStringify', () => {
  it('ignores key order and undefined, and serializes dates as ISO', () => {
    expect(stableStringify({ b: 1, a: { d: undefined, c: new Date('2026-01-01T00:00:00Z') } })).toBe(
      stableStringify({ a: { c: new Date('2026-01-01T00:00:00Z') }, b: 1 }),
    );
  });
});
