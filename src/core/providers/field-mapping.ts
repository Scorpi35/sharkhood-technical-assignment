import type { EntityKind, StageOutcome } from '../pipeline/types';

/**
 * Named, pure value transforms usable from a declarative FieldMapping.
 * Every transform passes null/undefined through unchanged, so they compose.
 */
type TransformResult = { ok: true; value: unknown } | { ok: false; message: string };
type Transform = (value: unknown) => TransformResult;

const pass = (value: unknown): TransformResult => ({ ok: true, value });
const nullish = (v: unknown): v is null | undefined => v === null || v === undefined;

export const TRANSFORMS = {
  /** Trim and collapse internal whitespace runs to one space. Unicode is kept as-is. */
  trimCollapse: (v) =>
    nullish(v) ? pass(v) : typeof v === 'string' ? pass(v.trim().replace(/\s+/g, ' ')) : { ok: false, message: 'expected a string' },
  /** '' (after any trimming) becomes null. */
  emptyToNull: (v) => pass(v === '' ? null : v),
  /** 0 becomes null, e.g. "0 means unrated". */
  zeroToNull: (v) => pass(v === 0 ? null : v),
  /** Number or numeric string to number. */
  toNumber: (v) => {
    if (nullish(v)) return pass(v);
    const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
    return Number.isFinite(n) ? pass(n) : { ok: false, message: `expected a number, got ${JSON.stringify(v)}` };
  },
  /** Major to integer minor units: Math.round(n * 100). Absorbs float32 noise. */
  toMinorUnits: (v) =>
    nullish(v) ? pass(v) : typeof v === 'number' && Number.isFinite(v) ? pass(Math.round(v * 100)) : { ok: false, message: 'expected a number' },
} satisfies Record<string, Transform>;

export type TransformName = keyof typeof TRANSFORMS;

/**
 * Declarative field mapping: read `from` (dot path) on the normalised source,
 * run `transforms` in order, write to `target` ("<entity>.<dot path>").
 *
 *   { target: 'restaurant.name', from: 'name', transforms: ['trimCollapse'] }
 */
export interface FieldMapping {
  readonly target: `${EntityKind}.${string}`;
  readonly from: string;
  readonly transforms?: readonly TransformName[];
}

/**
 * Build the data object for one entity from the mappings that target it.
 * A source value that resolves to `undefined` is omitted, so a source only
 * writes the fields it owns. A failing transform is a TRANSFORM_ERROR on `from`.
 */
export function applyFieldMappings(
  entity: EntityKind,
  source: unknown,
  mappings: readonly FieldMapping[],
): StageOutcome<Record<string, unknown>> {
  const prefix = `${entity}.`;
  const out: Record<string, unknown> = {};
  for (const m of mappings) {
    if (!m.target.startsWith(prefix)) continue;
    let value = getPath(source, m.from);
    for (const name of m.transforms ?? []) {
      const r = TRANSFORMS[name](value);
      if (!r.ok) {
        return { ok: false, issue: { reason: 'TRANSFORM_ERROR', message: `${name}: ${r.message}`, path: m.from } };
      }
      value = r.value;
    }
    if (value !== undefined) setPath(out, m.target.slice(prefix.length), value);
  }
  return { ok: true, value: out };
}

export function getPath(source: unknown, path: string): unknown {
  let cur: unknown = source;
  for (const part of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  let cur = target;
  for (const part of parts.slice(0, -1)) {
    if (cur[part] === null || typeof cur[part] !== 'object') cur[part] = {};
    cur = cur[part] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]] = value;
}
