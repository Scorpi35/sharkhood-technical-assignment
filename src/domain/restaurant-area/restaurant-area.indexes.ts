import type { IndexDescription } from 'mongodb';

export const RESTAURANT_AREAS = 'restaurant_areas';

/** docs/DATA_ANALYSIS.md §5 */
export const RESTAURANT_AREA_INDEXES: readonly IndexDescription[] = [
  // Natural key of the coverage edge; also serves "areas this restaurant delivers to" (prefix).
  {
    key: { platform: 1, restaurantExternalId: 1, areaExternalId: 1 },
    name: 'platform_restaurantExternalId_areaExternalId_unique',
    unique: true,
  },
  // "Restaurants delivering to area X": the unique key starts with the restaurant, so it can't serve this.
  { key: { platform: 1, areaExternalId: 1 }, name: 'platform_areaExternalId' },
];
