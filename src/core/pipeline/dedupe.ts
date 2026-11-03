import { stableStringify } from './stable-stringify';
import type { DomainRecord, RecordVersion } from './types';

export interface DedupeResult {
  readonly winners: DomainRecord[];
  /** Records that lost to a newer record with the same entity + key. */
  readonly deduplicated: number;
}

/** Grouping key: entity plus the natural key, independent of key property order. */
export const recordGroupKey = (r: Pick<DomainRecord, 'entity' | 'key'>): string => `${r.entity}|${stableStringify(r.key)}`;

/**
 * Total order on versions: newer sourceTs wins; on a tie, the larger rawId wins.
 * Returns > 0 when `a` should win over `b`.
 */
export function compareVersions(a: RecordVersion, b: RecordVersion): number {
  const byTs = a.sourceTs.getTime() - b.sourceTs.getTime();
  if (byTs !== 0) return byTs;
  return a.rawId < b.rawId ? -1 : a.rawId > b.rawId ? 1 : 0;
}

/**
 * Keep one record per (entity, key): the one with the max (sourceTs, rawId).
 * Two records with the same version (the same raw doc read twice) fall back to
 * comparing their data, so the winner never depends on input order.
 */
export function dedupe(records: readonly DomainRecord[]): DedupeResult {
  const best = new Map<string, DomainRecord>();
  for (const record of records) {
    const groupKey = recordGroupKey(record);
    const current = best.get(groupKey);
    if (!current || beats(record, current)) best.set(groupKey, record);
  }
  return { winners: [...best.values()], deduplicated: records.length - best.size };
}

function beats(a: DomainRecord, b: DomainRecord): boolean {
  const byVersion = compareVersions(a.version, b.version);
  if (byVersion !== 0) return byVersion > 0;
  return stableStringify(a.data) > stableStringify(b.data);
}
