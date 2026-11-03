import { AreaData, DomainRecordDraft, fail, ok, SourceHandler, StageOutcome, toIdString } from '../../../core';
import { atPath, validateEnvelope } from '../envelope';
import { compiled, LOCATION_MAPPING, RAW_COLLECTIONS, XBYTE_TRANSFORMS } from '../mappings';
import { LocationsDoc, locationsDocSchema } from '../schemas';

type Valid = LocationsDoc & { platform: string };
interface Normalised {
  readonly platform: string;
  readonly rows: LocationsDoc['payload']['results'];
}

/**
 * xbyte_raw_locations: one area record per result row. The 8 sample documents are
 * identical snapshots; their records collapse in dedupe and upsert as no-ops.
 */
export function createLocationsHandler(batchSize?: number): SourceHandler<Valid, Normalised> {
  return {
    rawCollection: RAW_COLLECTIONS.locations,
    alias: 'locations',
    batchSize,
    mapping: LOCATION_MAPPING,
    transforms: XBYTE_TRANSFORMS,
    validate: (body) => validateEnvelope(locationsDocSchema, body),
    normalise: (doc) => ({ platform: doc.platform, rows: doc.payload.results }),
    map: (n) =>
      n.rows.map((row, i): StageOutcome<DomainRecordDraft> => {
        const at = `payload.results[${i}]`;
        const id = toIdString(row.location_id);
        if (!id.ok) return fail(atPath(id.issue, `${at}.location_id`));
        const data = compiled.location(row);
        if (!data.ok) return fail(atPath(data.issue, at));
        return ok({ entity: 'area', key: { platform: n.platform, externalId: id.value! }, data: data.value.area as AreaData });
      }),
  };
}
