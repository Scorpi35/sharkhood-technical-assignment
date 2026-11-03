/**
 * JSON with object keys sorted at every level, so equal values always produce
 * equal strings regardless of key insertion order. Dates become ISO strings.
 * Used for grouping keys and deterministic tie-breaks; not a general serializer.
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(normalise(value));
}

function normalise(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(normalise);
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(obj).sort()) {
      if (obj[k] !== undefined) out[k] = normalise(obj[k]);
    }
    return out;
  }
  return value;
}
