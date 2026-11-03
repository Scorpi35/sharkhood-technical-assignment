import type { IndexDescription } from 'mongodb';

export const MENU_ITEMS = 'menu_items';

/** docs/DATA_ANALYSIS.md §5 */
export const MENU_ITEM_INDEXES: readonly IndexDescription[] = [
  // Natural key for idempotent item upserts. Its (platform, restaurantExternalId)
  // prefix also covers "all items of a restaurant" and the availability
  // reconciliation, so there is deliberately no separate index for that.
  { key: { platform: 1, restaurantExternalId: 1, itemId: 1 }, name: 'platform_restaurantExternalId_itemId_unique', unique: true },
  // "Items in category C"; categoryIds is an array, so this is a multikey index.
  { key: { categoryIds: 1 }, name: 'categoryIds_multikey' },
];
