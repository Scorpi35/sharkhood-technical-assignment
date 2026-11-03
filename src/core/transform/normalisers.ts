import { fail, GeoPoint, ok, StageOutcome } from '../pipeline/types';

/**
 * Provider-agnostic, pure value normalisers. Each returns `ok(value | null)`, or
 * an Issue (SCHEMA_INVALID) when the input is present but unusable. `null` and
 * `undefined` inputs always normalise to `null`, so absent fields stay explicit.
 * No I/O, no clock, no globals, no module-level mutable state (lint-enforced).
 */
export type Normalised<T> = StageOutcome<T | null>;

const invalid = (message: string): StageOutcome<never> => fail({ reason: 'SCHEMA_INVALID', message });
const isNil = (v: unknown): v is null | undefined => v === null || v === undefined;
const describe = (v: unknown): string => (typeof v === 'string' ? JSON.stringify(v) : String(v));

/** Trim, collapse internal whitespace (any Unicode space) to one space, NFC-normalise. */
export function trimCollapse(value: unknown): Normalised<string> {
  if (isNil(value)) return ok(null);
  if (typeof value !== 'string') return invalid(`expected a string, got ${typeof value}`);
  return ok(value.normalize('NFC').trim().replace(/\s+/g, ' '));
}

/** Blank strings (empty or whitespace-only) become null. Other values pass through. */
export function emptyToNull(value: unknown): Normalised<unknown> {
  if (isNil(value)) return ok(null);
  return ok(typeof value === 'string' && value.trim() === '' ? null : value);
}

/** Strings matching any placeholder pattern (e.g. /^0+-0+$/ for "00000-00000") become null. */
export function placeholderToNull(value: unknown, patterns: readonly RegExp[]): Normalised<unknown> {
  patterns.forEach(assertStatelessPattern);
  if (isNil(value)) return ok(null);
  return ok(typeof value === 'string' && patterns.some((p) => p.test(value.trim())) ? null : value);
}

const DECIMAL = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;

/** Finite number, or a decimal numeric string ("6.5", " 9 "). Blank -> null. Anything else is an issue. */
export function toNumber(value: unknown): Normalised<number> {
  if (isNil(value)) return ok(null);
  if (typeof value === 'number') return Number.isFinite(value) ? ok(value) : invalid(`expected a finite number, got ${value}`);
  if (typeof value === 'string') {
    const s = value.trim();
    if (s === '') return ok(null);
    if (DECIMAL.test(s)) return ok(Number(s));
  }
  return invalid(`expected a number, got ${describe(value)}`);
}

/**
 * Major units to integer minor units: Math.round(n * 10^decimals). Rounding absorbs
 * float32 noise (50.80000076293945 -> 5080). Accepts numeric strings ("9" -> 900).
 */
export function toMinorUnits(value: unknown, decimals = 2): Normalised<number> {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 6) {
    throw new RangeError(`toMinorUnits: decimals must be an integer 0..6, got ${decimals}`);
  }
  const n = toNumber(value);
  if (!n.ok || n.value === null) return n;
  return ok(Math.round(n.value * 10 ** decimals) + 0); // + 0 turns -0 into 0
}

/** 0 becomes null ("0 means unrated"). Every other value passes through unchanged. */
export function zeroToNull(value: unknown): Normalised<unknown> {
  if (isNil(value)) return ok(null);
  return ok(value === 0 ? null : value);
}

export interface DurationRange {
  readonly minMinutes: number;
  readonly maxMinutes: number;
}

const DURATION = /^(\d+)\s*(?:[-–]\s*(\d+))?\s*(?:mins?|minutes?)$/i;

/**
 * "25-40 mins" -> {25, 40}; "30 mins" -> {30, 30}. En dash and "min"/"minutes"
 * are accepted. A zero duration ("0 mins") is never a real delivery time, so it
 * means unknown -> null. Free text ("soon") or min > max is an issue.
 */
export function parseDurationRange(value: unknown): Normalised<DurationRange> {
  if (isNil(value)) return ok(null);
  if (typeof value !== 'string') return invalid(`expected a duration string, got ${typeof value}`);
  const s = value.trim();
  if (s === '') return ok(null);
  const m = DURATION.exec(s);
  if (!m) return invalid(`unrecognised duration ${describe(value)}`);
  const min = Number(m[1]);
  const max = m[2] === undefined ? min : Number(m[2]);
  if (min > max) return invalid(`duration range is inverted: ${describe(value)}`);
  if (max === 0) return ok(null);
  return ok({ minMinutes: min, maxMinutes: max });
}

/**
 * Latitude/longitude (numbers or numeric strings) to a GeoJSON Point [lng, lat].
 * Never an issue: missing, non-numeric, out-of-range or (0, 0) ("null island",
 * a classic placeholder) all yield null, so a bad coordinate never drops a record.
 */
export function toGeoPoint(lat: unknown, lng: unknown): Normalised<GeoPoint> {
  const la = toNumber(lat);
  const lo = toNumber(lng);
  if (!la.ok || !lo.ok || la.value === null || lo.value === null) return ok(null);
  if (la.value < -90 || la.value > 90 || lo.value < -180 || lo.value > 180) return ok(null);
  if (la.value === 0 && lo.value === 0) return ok(null);
  return ok({ type: 'Point', coordinates: [lo.value, la.value] });
}

/** First capture group of `pattern` in `url`, as a positive integer id. No match is an issue. */
export function extractUrlId(url: unknown, pattern: RegExp): Normalised<number> {
  const seg = extractUrlSegment(url, pattern);
  if (!seg.ok || seg.value === null) return seg as Normalised<number>;
  if (!/^\d+$/.test(seg.value) || Number(seg.value) <= 0 || !Number.isSafeInteger(Number(seg.value))) {
    return invalid(`expected a positive integer id in ${describe(url)}, got ${describe(seg.value)}`);
  }
  return ok(Number(seg.value));
}

/** First capture group of `pattern` in `url`, as a string. No match is an issue. */
export function extractUrlSegment(url: unknown, pattern: RegExp): Normalised<string> {
  assertStatelessPattern(pattern);
  assertHasCaptureGroup(pattern);
  if (isNil(url)) return ok(null);
  if (typeof url !== 'string') return invalid(`expected a URL string, got ${typeof url}`);
  const m = pattern.exec(url);
  if (!m || m[1] === undefined) return invalid(`URL ${describe(url)} does not match ${pattern}`);
  return ok(m[1]);
}

/**
 * Canonical external-id string: safe non-negative integers and digit strings
 * become decimal without leading zeros (1468, "1468", "01468" -> "1468"); other
 * non-blank strings (e.g. UUIDs) are kept trimmed. Anything else is an issue.
 */
export function toIdString(value: unknown): Normalised<string> {
  if (isNil(value)) return ok(null);
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 ? ok(String(value)) : invalid(`expected a non-negative integer id, got ${value}`);
  }
  if (typeof value === 'string') {
    const s = value.trim();
    if (s === '') return invalid('expected an id, got a blank string');
    return ok(/^\d+$/.test(s) ? s.replace(/^0+(?=\d)/, '') : s);
  }
  return invalid(`expected an id, got ${typeof value}`);
}

/** URL without its query string and fragment ("…/slug?aid=1468" -> "…/slug"). */
export function stripUrlQuery(value: unknown): Normalised<string> {
  if (isNil(value)) return ok(null);
  if (typeof value !== 'string') return invalid(`expected a URL string, got ${typeof value}`);
  const s = value.trim();
  if (s === '') return ok(null);
  return ok(s.replace(/[?#].*$/, ''));
}

// ------------------------------------------------------------------ pattern guards

/** /g and /y regexes carry lastIndex between calls: stateful, so impure. Rejected up front. */
function assertStatelessPattern(pattern: RegExp): void {
  if (pattern.global || pattern.sticky) {
    throw new TypeError(`pattern ${pattern} must not use the g or y flag (stateful lastIndex)`);
  }
}

function assertHasCaptureGroup(pattern: RegExp): void {
  const groups = new RegExp(`${pattern.source}|`).exec('')!.length - 1;
  if (groups < 1) throw new TypeError(`pattern ${pattern} needs a capture group`);
}
