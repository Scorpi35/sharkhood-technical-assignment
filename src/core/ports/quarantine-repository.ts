import type { IssueSeverity, QuarantineReason } from '../pipeline/types';

export const QUARANTINE_REPOSITORY = Symbol('QuarantineRepository');

/**
 * A rejected (or repaired) raw document or record. Never contains the raw body's
 * secrets: `details` comes from provider issues, which are sanitized at source.
 * Identity for deduplication: (runId, rawCollection, sourceId, reason, path).
 */
export interface QuarantineEntry {
  readonly runId: string;
  readonly jobId?: string;
  readonly batchKey: string;
  readonly rawCollection: string;
  readonly sourceId: string;
  readonly stage?: string;
  readonly reason: QuarantineReason;
  readonly message: string;
  readonly path?: string;
  readonly details?: unknown;
  readonly severity: IssueSeverity;
}

export interface StoredQuarantineEntry extends QuarantineEntry {
  /** Store-assigned id; ascending, used as the pagination cursor. */
  readonly id: string;
}

export interface QuarantinePage {
  readonly entries: StoredQuarantineEntry[];
  /** Pass as `cursor` for the next page; absent on the last page. */
  readonly nextCursor?: string;
}

export interface QuarantineQuery {
  readonly cursor?: string;
  readonly limit: number;
  readonly reason?: QuarantineReason;
  readonly severity?: IssueSeverity;
}

export interface QuarantineRepository {
  /**
   * Upsert on (runId, rawCollection, sourceId, reason, path): a retried batch
   * re-adds the same entries without duplicating them. Returns how many were new.
   */
  add(entries: readonly QuarantineEntry[]): Promise<number>;
  /** Keyset pagination by id within a run (no skip), optionally filtered. */
  list(runId: string, query: QuarantineQuery): Promise<QuarantinePage>;
  countByReason(runId: string): Promise<Record<QuarantineReason, number>>;
}
