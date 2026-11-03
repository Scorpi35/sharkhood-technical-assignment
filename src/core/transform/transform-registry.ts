import { fail, StageOutcome } from '../pipeline/types';
import {
  emptyToNull,
  extractUrlId,
  extractUrlSegment,
  parseDurationRange,
  placeholderToNull,
  stripUrlQuery,
  toGeoPoint,
  toIdString,
  toMinorUnits,
  toNumber,
  trimCollapse,
  zeroToNull,
} from './normalisers';

/** A named, single-input transform as used by a FieldMapping. */
export type Transform = (value: unknown) => StageOutcome<unknown>;

/** Built-ins that need no configuration. */
export const BUILTIN_TRANSFORMS: Readonly<Record<string, Transform>> = Object.freeze({
  trimCollapse,
  emptyToNull,
  toNumber,
  toMinorUnits: (v: unknown) => toMinorUnits(v),
  zeroToNull,
  parseDurationRange,
  toIdString,
  stripUrlQuery,
  /** Expects the mapping to read two paths: from: ['lat path', 'lng path']. */
  toGeoPoint: (v: unknown) =>
    Array.isArray(v) && v.length === 2
      ? toGeoPoint(v[0], v[1])
      : fail({ reason: 'SCHEMA_INVALID', message: 'toGeoPoint expects [lat, lng] (map it from two paths)' }),
});

/**
 * Factories for parameterised normalisers. A provider binds configured instances
 * under its own names, e.g.
 *   new TransformRegistry({ outletId: transformFactories.extractUrlId(/\/restaurant\/(\d+)\//) })
 * Patterns are checked when the factory is called (module init), not per value.
 */
export const transformFactories = {
  placeholderToNull: (patterns: readonly RegExp[]): Transform => {
    placeholderToNull(null, patterns); // validates the patterns now
    return (v) => placeholderToNull(v, patterns);
  },
  extractUrlId: (pattern: RegExp): Transform => {
    extractUrlId(null, pattern);
    return (v) => extractUrlId(v, pattern);
  },
  extractUrlSegment: (pattern: RegExp): Transform => {
    extractUrlSegment(null, pattern);
    return (v) => extractUrlSegment(v, pattern);
  },
  toMinorUnits: (decimals: number): Transform => {
    toMinorUnits(null, decimals);
    return (v) => toMinorUnits(v, decimals);
  },
};

export class TransformRegistryError extends Error {
  override readonly name = 'TransformRegistryError';
}

/** Name -> Transform lookup: the built-ins plus a provider's own bound transforms. */
export class TransformRegistry {
  private readonly transforms: ReadonlyMap<string, Transform>;

  constructor(custom: Readonly<Record<string, Transform>> = {}) {
    const clash = Object.keys(custom).filter((name) => name in BUILTIN_TRANSFORMS);
    if (clash.length > 0) {
      throw new TransformRegistryError(`custom transforms must not shadow built-ins: ${clash.join(', ')}`);
    }
    this.transforms = new Map(Object.entries({ ...BUILTIN_TRANSFORMS, ...custom }));
  }

  get(name: string): Transform | undefined {
    return this.transforms.get(name);
  }

  has(name: string): boolean {
    return this.transforms.has(name);
  }

  names(): string[] {
    return [...this.transforms.keys()].sort();
  }
}

/** Built-ins only. Used when a SourceHandler does not bring its own registry. */
export const DEFAULT_TRANSFORMS = new TransformRegistry();
