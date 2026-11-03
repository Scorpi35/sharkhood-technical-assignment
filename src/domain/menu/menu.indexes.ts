import type { IndexDescription } from 'mongodb';

export const MENUS = 'menus';

/** docs/DATA_ANALYSIS.md §5 */
export const MENU_INDEXES: readonly IndexDescription[] = [
  // One menu per restaurant; the natural key. Upserts replace the snapshot.
  { key: { platform: 1, restaurantExternalId: 1 }, name: 'platform_restaurantExternalId_unique', unique: true },
];
