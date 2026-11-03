import { compileMapping, FieldMapping, mappingFor, ok, parseDurationRange, transformFactories, TransformRegistry } from '../../core';

/*
 * Everything xbyte-specific that is data, not code. Handlers stay thin.
 *
 * Field ownership on `restaurants` (both sources upsert the same document, so each
 * field has exactly one owner and the two sources never overwrite each other):
 *
 *   | Field                                   | Owner (raw collection)   | From                                  |
 *   |-----------------------------------------|--------------------------|---------------------------------------|
 *   | listing.name                            | xbyte_raw_restaurants    | restaurant_name                       |
 *   | listing.url                             | xbyte_raw_restaurants    | restaurant_url, query string stripped |
 *   | slug                                    | xbyte_raw_restaurants    | restaurant_url path                   |
 *   | country                                 | xbyte_raw_restaurants    | restaurant_url path ("uae")           |
 *   | name                                    | xbyte_raw_menus          | name                                  |
 *   | vendorId                                | xbyte_raw_menus          | id (NOT the outlet id)                |
 *   | logoUrl                                 | xbyte_raw_menus          | logo                                  |
 *   | geo                                     | xbyte_raw_menus          | latitude, longitude                   |
 *   | rating.value / .count / .countIsLowerBound | xbyte_raw_menus       | rate, totalRatings                    |
 *   | delivery.* (fee, min/max minutes, minimum order, currency) | xbyte_raw_menus | deliveryFee, DeliveryTime, Minimum Order, URL country |
 *   | address.area / address.city             | xbyte_raw_menus          | Restaurant Address, City              |
 *   | contact                                 | xbyte_raw_menus          | Contact (placeholder -> null)         |
 *
 * Mirrored in docs/DATA_ANALYSIS.md §4.
 */

export const PROVIDER = 'xbyte';
export const KNOWN_PLATFORMS = ['talabat'] as const;

export const RAW_COLLECTIONS = {
  locations: 'xbyte_raw_locations',
  restaurants: 'xbyte_raw_restaurants',
  menus: 'xbyte_raw_menus',
} as const;

/** https://www.talabat.com/{country}/restaurant/{outletId}/{slug}?aid={areaId} */
export const RESTAURANT_URL = /\/([a-z]{2,3})\/restaurant\/(\d+)\/([^/?#]+)/;
// Single-capture variants of RESTAURANT_URL, one per segment, for the bound transforms.
const URL_COUNTRY = /\/([a-z]{2,3})\/restaurant\/\d+\/[^/?#]+/;
const URL_OUTLET_ID = /\/[a-z]{2,3}\/restaurant\/(\d+)\/[^/?#]+/;
const URL_SLUG = /\/[a-z]{2,3}\/restaurant\/\d+\/([^/?#]+)/;

/** Country URL segment -> ISO 4217 currency. An unmapped country is quarantined, never guessed. */
export const COUNTRY_CURRENCY: Readonly<Record<string, string>> = { uae: 'AED' };

/** Synthetic, curated categories: their items become isFeatured, the category itself is dropped. */
export const FEATURED_CATEGORY_NAME_PATTERNS: readonly RegExp[] = [/^picks for you/i];

/** Contact values that are placeholders, not phone numbers ("00000-00000"). */
export const CONTACT_PLACEHOLDERS: readonly RegExp[] = [/^0+-0+$/];

/** totalRatings is a display cap: 1000 means "1000+" (173/345 restaurants). */
export const RATING_COUNT_CAP = 1000;

/** Built-ins plus the xbyte-bound transforms the mappings below refer to by name. */
export const XBYTE_TRANSFORMS = new TransformRegistry({
  urlCountry: transformFactories.extractUrlSegment(URL_COUNTRY),
  urlOutletId: transformFactories.extractUrlSegment(URL_OUTLET_ID),
  urlSlug: transformFactories.extractUrlSegment(URL_SLUG),
  contactPlaceholder: transformFactories.placeholderToNull(CONTACT_PLACEHOLDERS),
  ratingCountIsCapped: (v) => ok(v === RATING_COUNT_CAP),
  durationMinMinutes: (v) => {
    const r = parseDurationRange(v);
    return r.ok ? ok(r.value?.minMinutes ?? null) : r;
  },
  durationMaxMinutes: (v) => {
    const r = parseDurationRange(v);
    return r.ok ? ok(r.value?.maxMinutes ?? null) : r;
  },
});

// ------------------------------------------------------------------ mappings

/** One `payload.results[]` row of xbyte_raw_locations. */
export const LOCATION_MAPPING: readonly FieldMapping[] = [
  { target: 'area.name', from: 'location_name', transforms: ['trimCollapse'] },
  { target: 'area.slug', from: 'location_slug', transforms: ['trimCollapse'] },
];

/** One `payload.results[]` row of xbyte_raw_restaurants. Listing-owned fields only. */
export const LISTING_MAPPING: readonly FieldMapping[] = [
  { target: 'restaurant.listing.name', from: 'restaurant_name', transforms: ['trimCollapse', 'emptyToNull'] },
  { target: 'restaurant.listing.url', from: 'restaurant_url', transforms: ['stripUrlQuery'] },
  { target: 'restaurant.slug', from: 'restaurant_url', transforms: ['urlSlug'] },
  { target: 'restaurant.country', from: 'restaurant_url', transforms: ['urlCountry'] },
];

/**
 * `payload.results[0]` of xbyte_raw_menus, plus `_currency` derived from the menu
 * URL's country by the handler. Menu-owned fields only.
 */
export const MENU_RESTAURANT_MAPPING: readonly FieldMapping[] = [
  { target: 'restaurant.name', from: 'name', transforms: ['trimCollapse', 'emptyToNull'] },
  { target: 'restaurant.vendorId', from: 'id', transforms: ['toIdString'] },
  { target: 'restaurant.logoUrl', from: 'logo', transforms: ['trimCollapse', 'emptyToNull'] },
  { target: 'restaurant.geo', from: ['latitude', 'longitude'], transforms: ['toGeoPoint'] },
  { target: 'restaurant.rating.value', from: 'rate', transforms: ['toNumber', 'zeroToNull'] },
  { target: 'restaurant.rating.count', from: 'totalRatings', transforms: ['toNumber'] },
  { target: 'restaurant.rating.countIsLowerBound', from: 'totalRatings', transforms: ['ratingCountIsCapped'] },
  { target: 'restaurant.delivery.feeMinor', from: 'deliveryFee', transforms: ['toMinorUnits'] },
  { target: 'restaurant.delivery.minMinutes', from: 'DeliveryTime', transforms: ['durationMinMinutes'] },
  { target: 'restaurant.delivery.maxMinutes', from: 'DeliveryTime', transforms: ['durationMaxMinutes'] },
  { target: 'restaurant.delivery.minimumOrderMinor', from: 'Minimum Order', transforms: ['toMinorUnits'] },
  { target: 'restaurant.delivery.currency', from: '_currency' },
  { target: 'restaurant.address.area', from: 'Restaurant Address', transforms: ['trimCollapse', 'emptyToNull'] },
  { target: 'restaurant.address.city', from: 'City', transforms: ['trimCollapse', 'emptyToNull'] },
  { target: 'restaurant.contact', from: 'Contact', transforms: ['trimCollapse', 'contactPlaceholder', 'emptyToNull'] },
];

/** One item of a menu category, plus `_currency`. categoryIds / isFeatured / isAvailable are structural. */
export const MENU_ITEM_MAPPING: readonly FieldMapping[] = [
  { target: 'menuItem.name', from: 'item_name', transforms: ['trimCollapse', 'emptyToNull'] },
  { target: 'menuItem.description', from: 'description', transforms: ['trimCollapse', 'emptyToNull'] },
  { target: 'menuItem.priceMinor', from: 'price', transforms: ['toMinorUnits'] },
  { target: 'menuItem.currency', from: '_currency' },
  { target: 'menuItem.rating', from: 'rating', transforms: ['toNumber', 'zeroToNull'] },
  { target: 'menuItem.imageUrl', from: 'image', transforms: ['trimCollapse', 'emptyToNull'] },
];

export const MENUS_MAPPING: readonly FieldMapping[] = [...MENU_RESTAURANT_MAPPING, ...MENU_ITEM_MAPPING];

/** Compiled at module init: an unknown transform name or bad target throws here, never mid-run. */
export const compiled = {
  location: compileMapping(LOCATION_MAPPING, XBYTE_TRANSFORMS),
  listing: compileMapping(LISTING_MAPPING, XBYTE_TRANSFORMS),
  menuRestaurant: compileMapping(mappingFor('restaurant', MENUS_MAPPING), XBYTE_TRANSFORMS),
  menuItem: compileMapping(mappingFor('menuItem', MENUS_MAPPING), XBYTE_TRANSFORMS),
  urlOutletId: XBYTE_TRANSFORMS.get('urlOutletId')!,
  urlCountry: XBYTE_TRANSFORMS.get('urlCountry')!,
};
