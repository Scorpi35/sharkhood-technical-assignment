import type { PipelineIssue } from '../pipeline/runner';
import type { QuarantineReason } from '../pipeline/types';

export const QUARANTINE_REPOSITORY = Symbol('QuarantineRepository');

/**
 * A rejected raw document. Carries the issue and where it came from, never the raw
 * body's secrets: `excerpt`, if set, must exclude endpoint / requests_url.
 */
export interface QuarantineEntry extends PipelineIssue {
  readonly runId: string;
  readonly batchKey: string;
  readonly excerpt?: unknown;
}

export interface StoredQuarantineEntry extends QuarantineEntry {
  /** Store-assigned id; ascending, used as the pagination cursor. */
  readonly id: string;
}

export interface QuarantinePage {
  readonly entries: StoredQuarantineEntry[];
  /** Pass as `afterId` for the next page; absent on the last page. */
  readonly nextAfterId?: string;
}

export interface QuarantineRepository {
  /**
   * Must be idempotent per (runId, rawCollection, sourceId, stage, reason, path):
   * a retried batch re-adds the same entries without duplicating them.
   */
  add(entries: readonly QuarantineEntry[]): Promise<void>;
  /** Keyset pagination by id within a run (no skip). */
  list(runId: string, page: { readonly afterId?: string; readonly limit: number }): Promise<QuarantinePage>;
  countByReason(runId: string): Promise<Record<QuarantineReason, number>>;
}
