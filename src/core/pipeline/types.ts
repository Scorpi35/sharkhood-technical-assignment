/**
 * Pipeline contracts. Provider-agnostic: nothing here knows about any specific provider, Mongo or BullMQ.
 * Entity shapes follow the target model in docs/DATA_ANALYSIS.md §4.
 */

/** One raw source document, as handed to the pipeline by a SourceReader. */
export interface RawDocument {
  /** Raw document id (hex ObjectId string for Mongo sources). */
  readonly id: string;
  /** Raw collection the document came from; selects the SourceHandler. */
  readonly collection: string;
  /** Source timestamp (raw `createdAt`). The only time the pipeline ever sees. */
  readonly sourceTs: Date;
  readonly body: unknown;
}

// ------------------------------------------------------------------ outcomes

export const QUARANTINE_REASONS = [
  'SCHEMA_INVALID',
  'PROVIDER_ERROR',
  'EMPTY_PAYLOAD',
  'TRANSFORM_ERROR',
  'DUPLICATE_CONFLICT',
] as const;
export type QuarantineReason = (typeof QUARANTINE_REASONS)[number];

/**
 * `error`: the data could not be used (the document or record is dropped).
 * `warning`: the data was used, but something was repaired along the way and
 * should be visible (e.g. two categories with the same id were merged).
 */
export type IssueSeverity = 'error' | 'warning';

/** A data problem (DocumentError). Routed to quarantine; the run continues. */
export interface Issue {
  readonly reason: QuarantineReason;
  readonly message: string;
  /** Dot path into the raw body, when the problem is a specific field or element. */
  readonly path?: string;
  readonly details?: unknown;
  /** Defaults to 'error'. */
  readonly severity?: IssueSeverity;
}

/**
 * A success may carry warnings: the value is used, the warnings are reported.
 * A failure drops its value: for validate/normalise that is the whole document,
 * for map it is that one record (see runPipeline).
 */
export type StageOutcome<T> =
  | { readonly ok: true; readonly value: T; readonly warnings?: readonly Issue[] }
  | { readonly ok: false; readonly issue: Issue };

export const ok = <T>(value: T, warnings: readonly Issue[] = []): StageOutcome<T> =>
  warnings.length > 0 ? { ok: true, value, warnings } : { ok: true, value };
export const fail = <T = never>(issue: Issue): StageOutcome<T> => ({ ok: false, issue });
export const warning = (issue: Omit<Issue, 'severity'>): Issue => ({ ...issue, severity: 'warning' });

// ------------------------------------------------------------------ domain records

export const ENTITY_KINDS = ['area', 'restaurant', 'restaurantArea', 'menu', 'menuItem'] as const;
export type EntityKind = (typeof ENTITY_KINDS)[number];

/*
 * External identifiers are canonical strings ("1468", not 1468): providers differ
 * in id types (ints, numeric strings, UUIDs), and a string key compares the same
 * way everywhere. Providers canonicalise (e.g. no leading zeros) before keying.
 */
export interface AreaKey {
  readonly platform: string;
  readonly externalId: string;
}
export interface RestaurantKey {
  readonly platform: string;
  readonly externalId: string;
}
export interface RestaurantAreaKey {
  readonly platform: string;
  readonly restaurantExternalId: string;
  readonly areaExternalId: string;
}
export interface MenuKey {
  readonly platform: string;
  readonly restaurantExternalId: string;
}
export interface MenuItemKey {
  readonly platform: string;
  readonly restaurantExternalId: string;
  readonly itemId: string;
}

export interface GeoPoint {
  readonly type: 'Point';
  /** [lng, lat] */
  readonly coordinates: readonly [number, number];
}

export interface AreaData {
  readonly name: string;
  readonly slug: string;
}

/**
 * Restaurants are written by more than one source with disjoint field ownership,
 * so every field is optional: a record carries only the fields its source owns
 * (see the ownership table in each provider's mappings.ts and DATA_ANALYSIS §4).
 */
export interface RestaurantData {
  /** Listing-owned: how the restaurant appears in area listings. */
  readonly listing?: { readonly name: string | null; readonly url: string | null };
  readonly slug?: string | null;
  readonly country?: string | null;
  /** Menu-owned. */
  readonly name?: string | null;
  readonly vendorId?: string | null;
  readonly logoUrl?: string | null;
  readonly geo?: GeoPoint | null;
  readonly rating?: { readonly value: number | null; readonly count: number | null; readonly countIsLowerBound: boolean };
  readonly delivery?: {
    readonly feeMinor: number | null;
    readonly minMinutes: number | null;
    readonly maxMinutes: number | null;
    readonly minimumOrderMinor: number | null;
    readonly currency: string;
  };
  readonly address?: { readonly area: string | null; readonly city: string | null };
  readonly contact?: string | null;
}

/** Coverage edge. firstSeenAt / lastSeenAt are derived from version.sourceTs by the writer. */
export type RestaurantAreaData = Readonly<Record<string, never>>;

export interface MenuCategory {
  readonly categoryId: string;
  readonly name: string;
  readonly position: number;
  readonly itemIds: readonly string[];
}
export interface MenuData {
  readonly categories: readonly MenuCategory[];
  readonly featuredItemIds: readonly string[];
}

export interface MenuItemData {
  readonly name: string | null;
  readonly description: string | null;
  readonly priceMinor: number | null;
  readonly currency: string;
  readonly rating: number | null;
  readonly imageUrl: string | null;
  readonly categoryIds: readonly string[];
  readonly isFeatured: boolean;
  readonly isAvailable: boolean;
}

export interface EntityShapes {
  area: { key: AreaKey; data: AreaData };
  restaurant: { key: RestaurantKey; data: RestaurantData };
  restaurantArea: { key: RestaurantAreaKey; data: RestaurantAreaData };
  menu: { key: MenuKey; data: MenuData };
  menuItem: { key: MenuItemKey; data: MenuItemData };
}

/** Which raw document produced a record; a total order for "newest wins". */
export interface RecordVersion {
  readonly sourceTs: Date;
  readonly rawId: string;
}

export interface RecordSource {
  readonly provider: string;
  readonly rawCollection: string;
}

/**
 * What a SourceHandler's map() emits. Handlers never see the raw document, so the
 * runner stamps `version` and `source` from it; a handler cannot get them wrong.
 */
export type DomainRecordDraft = {
  [E in EntityKind]: { readonly entity: E; readonly key: EntityShapes[E]['key']; readonly data: EntityShapes[E]['data'] };
}[EntityKind];

/** A stamped record, ready for dedupe and the TargetWriter. Discriminated by `entity`. */
export type DomainRecord = {
  [E in EntityKind]: {
    readonly entity: E;
    readonly key: EntityShapes[E]['key'];
    readonly data: EntityShapes[E]['data'];
    readonly version: RecordVersion;
    readonly source: RecordSource;
  };
}[EntityKind];

export type RecordOf<E extends EntityKind> = Extract<DomainRecord, { entity: E }>;
