import { ENTITY_KINDS, EntityKind, fail, ok, StageOutcome } from '../pipeline/types';
import { DEFAULT_TRANSFORMS, Transform, TransformRegistry } from './transform-registry';

/**
 * Declarative field mapping: read `from` (a dot path, or several for multi-input
 * transforms such as toGeoPoint), run `transforms` by name in order, write the
 * result to `target` ("<entity>.<dot path>").
 *
 *   { target: 'restaurant.name', from: 'name', transforms: ['trimCollapse'] }
 *   { target: 'restaurant.geo', from: ['latitude', 'longitude'], transforms: ['toGeoPoint'] }
 *
 * Every mapped target is always written (null when absent): the mapping list of a
 * source is exactly the set of fields that source owns.
 */
export interface FieldMapping {
  readonly target: `${EntityKind}.${string}`;
  readonly from: string | readonly string[];
  readonly transforms?: readonly string[];
}

export type CompiledMapping = (source: unknown) => StageOutcome<Record<string, unknown>>;

export class MappingError extends Error {
  override readonly name = 'MappingError';
  constructor(readonly problems: readonly string[]) {
    super(`invalid field mapping:\n  - ${problems.join('\n  - ')}`);
  }
}

const TARGET = new RegExp(`^(${ENTITY_KINDS.join('|')})(\\.[A-Za-z_][A-Za-z0-9_]*)+$`);

/**
 * Reject a mapping before any data flows: unknown transform names, malformed or
 * duplicate targets, and targets that would overwrite each other ("a.b" vs "a.b.c").
 * Collects every problem so one fix-up round is enough.
 */
export function validateMapping(mapping: readonly FieldMapping[], registry: TransformRegistry = DEFAULT_TRANSFORMS): void {
  const problems: string[] = [];
  const targets = new Set<string>();
  for (const m of mapping) {
    if (!TARGET.test(m.target)) problems.push(`${m.target}: target must be "<entity>.<field>[.<field>…]"`);
    if (targets.has(m.target)) problems.push(`${m.target}: mapped more than once`);
    targets.add(m.target);
    const from = typeof m.from === 'string' ? [m.from] : m.from;
    if (from.length === 0 || from.some((p) => p.trim() === '')) problems.push(`${m.target}: empty "from" path`);
    for (const name of m.transforms ?? []) {
      if (!registry.has(name)) problems.push(`${m.target}: unknown transform "${name}" (known: ${registry.names().join(', ')})`);
    }
  }
  for (const t of targets) {
    for (const other of targets) {
      if (other !== t && other.startsWith(`${t}.`)) problems.push(`${t}: overlaps with ${other}`);
    }
  }
  if (problems.length > 0) throw new MappingError(problems);
}

/**
 * Validate once and resolve every transform up front, so applying the mapping
 * per document can never hit an unknown name. Call this at module init.
 */
export function compileMapping(mapping: readonly FieldMapping[], registry: TransformRegistry = DEFAULT_TRANSFORMS): CompiledMapping {
  validateMapping(mapping, registry);
  const steps = mapping.map((m) => ({
    target: m.target.split('.'),
    from: m.from,
    label: typeof m.from === 'string' ? m.from : m.from.join(','),
    transforms: (m.transforms ?? []).map((name) => [name, registry.get(name) as Transform] as const),
  }));

  return (source) => {
    const out: Record<string, unknown> = {};
    for (const step of steps) {
      let value: unknown = typeof step.from === 'string' ? getPath(source, step.from) : step.from.map((p) => getPath(source, p));
      for (const [name, transform] of step.transforms) {
        const r = transform(value);
        if (!r.ok) return fail({ ...r.issue, message: `${name}: ${r.issue.message}`, path: r.issue.path ?? step.label });
        value = r.value;
      }
      setPath(out, step.target, value === undefined ? null : value);
    }
    return ok(out);
  };
}

/** One-shot convenience: compile + apply. Output is keyed by entity: { restaurant: {...}, menu: {...} }. */
export function applyMapping(
  source: unknown,
  mapping: readonly FieldMapping[],
  registry: TransformRegistry = DEFAULT_TRANSFORMS,
): StageOutcome<Record<string, unknown>> {
  return compileMapping(mapping, registry)(source);
}

/** The subset of a mapping that targets one entity, e.g. to apply item mappings per item. */
export function mappingFor(entity: EntityKind, mapping: readonly FieldMapping[]): FieldMapping[] {
  return mapping.filter((m) => m.target.startsWith(`${entity}.`));
}

export function getPath(source: unknown, path: string): unknown {
  let cur: unknown = source;
  for (const part of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function setPath(target: Record<string, unknown>, path: readonly string[], value: unknown): void {
  let cur = target;
  for (const part of path.slice(0, -1)) {
    if (cur[part] === null || typeof cur[part] !== 'object') cur[part] = {};
    cur = cur[part] as Record<string, unknown>;
  }
  cur[path[path.length - 1]] = value;
}
