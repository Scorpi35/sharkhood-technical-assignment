import { DomainRecordDraft, fail, ok, RestaurantData, SourceHandler, StageOutcome, toIdString } from '../../../core';
import { atPath, issueOf, validateEnvelope } from '../envelope';
import { compiled, LISTING_MAPPING, RAW_COLLECTIONS, XBYTE_TRANSFORMS } from '../mappings';
import { ListingRow, RestaurantsDoc, restaurantsDocSchema } from '../schemas';

type Valid = RestaurantsDoc & { platform: string };
interface Normalised {
  readonly platform: string;
  /** Canonical string form of params.areaId ("1468"), equal to the area's location_id key. */
  readonly areaExternalId: string;
  readonly rows: readonly ListingRow[];
}

/**
 * xbyte_raw_restaurants (area listing pages): per result row, a restaurant record
 * with listing-owned fields only, plus a restaurantArea coverage edge ("delivers
 * to this area"). A row whose URL does not parse is a record-level SCHEMA_INVALID;
 * the rest of the page still processes.
 */
export function createRestaurantsHandler(batchSize?: number): SourceHandler<Valid, Normalised> {
  return {
    rawCollection: RAW_COLLECTIONS.restaurants,
    alias: 'restaurants',
    batchSize,
    mapping: LISTING_MAPPING,
    transforms: XBYTE_TRANSFORMS,
    validate: (body) => validateEnvelope(restaurantsDocSchema, body),
    normalise: (doc) => ({
      platform: doc.platform,
      // Validated as a numeric id by the schema, so this cannot fail.
      areaExternalId: (toIdString(doc.params.areaId) as { value: string }).value,
      rows: doc.payload.results,
    }),
    map: (n) => n.rows.flatMap((row, i) => mapRow(n, row, `payload.results[${i}]`)),
  };
}

function mapRow(n: Normalised, row: ListingRow, at: string): StageOutcome<DomainRecordDraft>[] {
  const outlet = compiled.urlOutletId(row.restaurant_url);
  if (!outlet.ok || outlet.value === null) {
    const base = outlet.ok ? { reason: 'SCHEMA_INVALID' as const, message: 'restaurant_url is empty' } : outlet.issue;
    return [fail(issueOf({ ...base, path: `${at}.restaurant_url`, details: { restaurant_url: row.restaurant_url } }))];
  }
  const data = compiled.listing(row);
  if (!data.ok) return [fail(atPath(data.issue, at))];

  const restaurantExternalId = (toIdString(outlet.value) as { value: string }).value;
  return [
    ok({ entity: 'restaurant', key: { platform: n.platform, externalId: restaurantExternalId }, data: data.value.restaurant as RestaurantData }),
    ok({
      entity: 'restaurantArea',
      key: { platform: n.platform, restaurantExternalId, areaExternalId: n.areaExternalId },
      data: {},
    }),
  ];
}
