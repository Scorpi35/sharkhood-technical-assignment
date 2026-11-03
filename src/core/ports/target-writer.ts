import type { DomainRecord } from '../pipeline/types';

export const TARGET_WRITER = Symbol('TargetWriter');

export interface WriteResult {
  /** Inserted, or updated because the incoming record was newer and different. */
  readonly written: number;
  /** Same version and data already stored: a no-op (what a re-run should produce). */
  readonly unchanged: number;
  /** Rejected because the stored version is newer ("newest sourceTs wins"). */
  readonly stale: number;
}

/**
 * Write side of the target store. Implementations upsert on each entity's natural
 * key, apply a record only if its version is >= the stored one, and write only
 * the fields the record carries (disjoint ownership between sources).
 */
export interface TargetWriter {
  upsert(records: readonly DomainRecord[]): Promise<WriteResult>;
}
