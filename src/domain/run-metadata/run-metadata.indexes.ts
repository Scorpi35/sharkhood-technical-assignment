import type { IndexDescription } from 'mongodb';

export const RUNS = 'runs';
export const RUN_BATCHES = 'run_batches';
export const QUARANTINE = 'quarantine';

/** docs/DATA_ANALYSIS.md §5. `runs` is keyed by _id = runId and needs nothing else. */
export const RUN_METADATA_INDEXES: Readonly<Record<string, readonly IndexDescription[]>> = {
  [RUN_BATCHES]: [
    // Identity of a batch: re-dispatching a range upserts into the same row.
    { key: { runId: 1, batchKey: 1 }, name: 'runId_batchKey_unique', unique: true },
    // "Pending or failed batches of run R": progress, resume, retry after a worker is killed.
    { key: { runId: 1, status: 1 }, name: 'runId_status' },
  ],
  [QUARANTINE]: [
    // Identity of an issue: a retried batch upserts into the same row instead of duplicating it.
    { key: { runId: 1, rawCollection: 1, sourceId: 1, reason: 1, path: 1 }, name: 'runId_rawCollection_sourceId_reason_path_unique', unique: true },
    // Paginate a run's entries by _id (_id > cursor) without skip.
    { key: { runId: 1, _id: 1 }, name: 'runId__id' },
    // The same, filtered by reason (?reason=PROVIDER_ERROR).
    { key: { runId: 1, reason: 1, _id: 1 }, name: 'runId_reason__id' },
  ],
};
