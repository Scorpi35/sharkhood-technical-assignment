/* Test-only helpers shared by core specs. Not exported from src/core/index.ts. */
import type { DomainRecord, RawDocument, RecordOf } from './types';

/** Deterministic PRNG (mulberry32) so "random" shuffles are reproducible. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffle<T>(items: readonly T[], rand: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export const raw = (id: string, body: unknown, collection = 'raw_things', sourceTs = new Date('2026-01-01T00:00:00Z')): RawDocument => ({
  id,
  collection,
  sourceTs,
  body,
});

/** externalId of an area record (dedupe returns the DomainRecord union). */
export const areaIdOf = (r: DomainRecord): number => (r as RecordOf<'area'>).key.externalId;

export const areaRecord = (externalId: number, rawId: string, sourceTs: string, name = `area ${externalId}`): RecordOf<'area'> => ({
  entity: 'area',
  key: { platform: 'p', externalId },
  data: { name, slug: `area-${externalId}` },
  version: { sourceTs: new Date(sourceTs), rawId },
  source: { provider: 'test', rawCollection: 'raw_things' },
});
