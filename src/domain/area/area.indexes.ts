import type { IndexDescription } from 'mongodb';

export const AREAS = 'areas';

/** docs/DATA_ANALYSIS.md §5 */
export const AREA_INDEXES: readonly IndexDescription[] = [
  // Natural key: idempotent upserts; the database rejects duplicates.
  { key: { platform: 1, externalId: 1 }, name: 'platform_externalId_unique', unique: true },
  // Lookup by slug. Not unique: 11 slugs map to several location ids.
  { key: { slug: 1 }, name: 'slug' },
];
