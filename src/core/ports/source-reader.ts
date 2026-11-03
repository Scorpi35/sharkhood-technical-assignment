import type { RawDocument } from '../pipeline/types';

export const SOURCE_READER = Symbol('SourceReader');

export interface ScanIdsOptions {
  /** Exclusive lower bound; omit to start at the beginning. */
  readonly afterId?: string;
  /** Max ids per yielded page. */
  readonly limit: number;
}

/**
 * Read side of a raw store. Ids are opaque strings in ascending store order
 * (for Mongo: ObjectId hex order). Ranges are stable, so re-reading one returns
 * the same documents; that is what makes batch retries idempotent.
 */
export interface SourceReader {
  /** Ascending ids, in pages of at most `limit`. Used by the planner to cut ranges. */
  scanIds(collection: string, options: ScanIdsOptions): AsyncIterable<string[]>;
  /** Documents with fromId <= id <= toId (both inclusive), ascending, via a cursor. */
  readRange(collection: string, fromId: string, toId: string): AsyncIterable<RawDocument>;
}
