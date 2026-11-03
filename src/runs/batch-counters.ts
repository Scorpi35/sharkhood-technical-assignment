import type { PipelineIssue, PipelineResult, QuarantineEntry, RunCounters, SampledIssue, WriteResult } from '../core';

/**
 * A batch's counters from its pipeline and write results. Definitions are in
 * ARCHITECTURE.md ("Run counters"); invariant: written + unchanged + stale = transformed.
 */
export function batchCounters(pipeline: PipelineResult, write: WriteResult): RunCounters {
  const errors = pipeline.issues.filter((i) => i.severity === 'error');
  const skipped = errors.filter((i) => i.reason === 'EMPTY_PAYLOAD').length;
  return {
    read: pipeline.counters.rawDocuments,
    transformed: pipeline.counters.records,
    written: write.written,
    unchanged: write.unchanged,
    stale: write.stale,
    deduplicated: pipeline.counters.deduplicated,
    skipped,
    failed: errors.length - skipped,
    warnings: pipeline.counters.warnings,
  };
}

/** Every issue of a batch, errors and warnings, as quarantine rows. */
export function quarantineEntries(runId: string, batchKey: string, jobId: string | undefined, issues: readonly PipelineIssue[]): QuarantineEntry[] {
  return issues.map((i) => ({
    runId,
    ...(jobId === undefined ? {} : { jobId }),
    batchKey,
    rawCollection: i.rawCollection,
    sourceId: i.sourceId,
    stage: i.stage,
    reason: i.reason,
    message: i.message,
    ...(i.path === undefined ? {} : { path: i.path }),
    ...(i.details === undefined ? {} : { details: i.details }),
    severity: i.severity,
  }));
}

/** Error-severity issues (not skips) in the shape kept in the run's capped error sample. */
export function sampledErrors(batchKey: string, issues: readonly PipelineIssue[]): SampledIssue[] {
  return issues
    .filter((i) => i.severity === 'error' && i.reason !== 'EMPTY_PAYLOAD')
    .map((i) => ({
      reason: i.reason,
      message: i.message,
      severity: i.severity,
      sourceId: i.sourceId,
      rawCollection: i.rawCollection,
      batchKey,
      ...(i.path === undefined ? {} : { path: i.path }),
    }));
}
