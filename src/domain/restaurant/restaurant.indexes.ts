import type { IndexDescription } from 'mongodb';

export const RESTAURANTS = 'restaurants';

/** docs/DATA_ANALYSIS.md §5 */
export const RESTAURANT_INDEXES: readonly IndexDescription[] = [
  // Natural key; both sources (listings and menus) upsert on it.
  { key: { platform: 1, externalId: 1 }, name: 'platform_externalId_unique', unique: true },
  // "Restaurants near a point" on the GeoJSON Point. Docs with geo: null are simply not indexed.
  { key: { geo: '2dsphere' }, name: 'geo_2dsphere' },
];
