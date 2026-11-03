# Architecture

How the migration service is put together. For the data itself (source shapes,
anomalies, the target model and the reasoning behind it), read
**[docs/DATA_ANALYSIS.md](./docs/DATA_ANALYSIS.md)** first.

> Status: T01–T12 are built (bootstrap, raw seed, core pipeline, transforms, xbyte provider, Mongo repositories, runs, queue). Sections marked
> *planned* describe the design that later tickets implement.

## Components

```mermaid
flowchart LR
    files["data/raw/*.json<br/>(Extended JSON)"] -- "npm run seed<br/>(stream + upsert by _id)" --> raw[("Mongo<br/>provider_raw")]
    api["api<br/>APP_ROLE=api"] -- "start run: dispatch job per source" --> redis[("Redis<br/>BullMQ")]
    redis -- "batch jobs: {runId, rawCollection, fromId, toId, batchKey}" --> worker["worker(s)<br/>APP_ROLE=worker"]
    worker -- "cursor over _id range" --> raw
    worker -- "idempotent upserts" --> target[("Mongo<br/>provider_domain")]
    worker -- "runs / run_batches / quarantine" --> target
```

| Component | Runs as | Responsibility |
|---|---|---|
| `api` | `APP_ROLE=api` (HTTP, port 3000) | `POST /runs`, `GET /runs/:id`, `GET /runs/:id/errors`, `POST /runs/:id/resume`, `GET /health` (see README) |
| `worker` | `APP_ROLE=worker` (no HTTP; one or more containers) | *Planned:* process `_id`-range jobs: read raw, transform, upsert target. A separate container, so `docker compose kill worker` can demonstrate resumability. |
| seed | `npm run seed` | Streams the sample files into `provider_raw` (T02) |
| Mongo | `mongo:7` | `provider_raw` (source, read-only by convention) and `provider_domain` (target + run metadata) |
| Redis | `redis:7` | BullMQ queues. Holds job *ranges* only, never documents. |

## Layers

| Path | Contains | May import |
|---|---|---|
| `src/core/**` | Provider-agnostic, pure logic and interfaces | Not `src/providers`, `src/domain`, `mongodb`, `bullmq` or `@nestjs/*` values (lint-enforced) |
| `src/providers/**` | Per-provider knowledge: Zod schemas, declarative mappings, source handlers (xbyte, T06) | core, domain |
| `src/domain/**` | Target collections, versioned upserts, run metadata, indexes (T07/T08) | core |
| `src/infra/**` | Mongo client, SourceReader, raw seed (T02/T07) | core |
| `src/config`, `src/logging` | Configuration and logging | anything |

Transforms are pure. They don't call `Date.now()` or `Math.random()`, do no I/O
and hold no module-level state, so the same raw document always maps to the same
target document. Bad data surfaces as a `DocumentError` result, which goes to
quarantine and lets the run continue. Infrastructure failures throw, and BullMQ
retries them.

## Runs

A run migrates one or more raw collections. Everything needed to answer "what
did this run do?" is persisted in three collections (`src/runs`, with the Mongo
implementations in `src/domain/run-metadata`):

| Collection | One document per | Holds |
|---|---|---|
| `runs` | run (`_id` = runId, a UUID) | status, filters, config, per-source dispatch progress, counters, timings, a capped `errorSample`, `lastError` |
| `run_batches` | `_id` range (`batchKey` = `rawCollection:fromId:toId`) | status `queued`/`active`/`completed`/`dead`, attempts, the batch's counters, `lastError` |
| `quarantine` | issue (`runId, rawCollection, sourceId, reason, path`) | the issue (reason, message, path, sanitized details, severity), its batch and job |

```mermaid
stateDiagram-v2
    [*] --> pending: createRun
    pending --> dispatching: startDispatch
    dispatching --> running: finishDispatch (every source dispatched)
    running --> completed: all batches settled, failed = 0, dead = 0
    running --> completed_with_errors: all batches settled, failed > 0 or dead > 0
    pending --> failed: failRun
    dispatching --> failed: failRun
    running --> failed: failRun
```

### Run counters

Every batch reports these counters. The run's counters are their sum over completed batches.

| Counter | Definition |
|---|---|
| `read` | raw documents read |
| `transformed` | domain records produced (after in-batch dedupe), i.e. sent to the writer |
| `written` | records inserted or modified |
| `unchanged` | records matched with no change (what a re-run produces) |
| `stale` | records rejected because the stored version is newer |
| `deduplicated` | in-batch losers (same key, older version) |
| `skipped` | `EMPTY_PAYLOAD` documents: quarantined for visibility, but not failures |
| `failed` | quarantined documents/records with error severity, excluding skips |
| `warnings` | repairs that were reported but still written (e.g. merged categories) |

Invariant: `written + unchanged + stale = transformed`.

### Exactly once, and crash-safe

- **Exactly once.** A batch's counters reach the run only through the call that
  moves the batch to a settled status (`findOneAndUpdate({status: {$nin:
  [completed, dead]}})`). A retried or duplicated completion finds nothing to
  transition and adds nothing.
- **Crash-safe.** The batch and the run are separate documents, so a crash can
  land between "batch completed" and "run incremented". Finalisation therefore
  never trusts the run's live counters: it **recomputes** them, and every
  source's batch totals, from `run_batches`. It is re-attempted on every
  settled batch and on `finishDispatch`, so the retried job still finalises
  the run with correct totals.
- **Quarantine.** Entries are upserted on their identity, so a retried batch
  never duplicates them. The first occurrence is kept. They are paginated by
  `_id` cursor and can be filtered by reason or severity.

## Queue (BullMQ)

| Queue | Job | Data |
|---|---|---|
| `factory-dispatch` | one per (run, raw collection), id `dispatch__<runId>__<rawCollection>` | `{runId, rawCollection}` |
| `factory-batch` | one per `_id` range, id `batch__<runId>__<batchKey>` | `{runId, rawCollection, fromId, toId, batchKey}`: a range, never documents |
| `factory-dead-letter` | one per exhausted batch, id `dead__<runId>__<batchKey>` | `{runId, batchKey, error, stack}` |

Job ids are deterministic, so BullMQ ignores a duplicate `add()` and
re-dispatching never double-enqueues. BullMQ 6 rejects `:` in custom ids, so
the `:` of a batch key becomes `__`.

```mermaid
sequenceDiagram
    participant A as api (RunsService.start)
    participant D as dispatch worker
    participant B as batch workers (WORKER_CONCURRENCY)
    participant M as Mongo
    A->>M: create run (pending -> dispatching)
    A->>D: one dispatch job per source
    loop each page of batchSize _ids (resumes after dispatchCursor)
        D->>M: upsert run_batches row (queued)
        D->>B: add batch job (deterministic id)
        D->>M: $set dispatchCursor, $inc batchesTotal (new rows only)
    end
    D->>M: dispatchDone (the last source moves the run to running)
    B->>M: readRange, runPipeline, upsert, quarantine, completeBatch
    Note over B,M: completeBatch finalises the run when every batch is settled
```

- **Dispatcher.** It pages a collection with `scanIds` and resumes after the
  run's `dispatchCursor`. The cursor only moves **after** the batch job is
  enqueued, so a crash can never skip a range. Filters: `collections` selects
  the handlers, and `limit` caps the documents per collection (tracked as
  `dispatchedDocs`, so it survives restarts).
- **Batch worker.** Document problems never throw; they are quarantined.
  Infrastructure errors (Mongo, Redis) propagate, so BullMQ retries with
  `attempts: JOB_ATTEMPTS` and exponential backoff from `JOB_BACKOFF_MS`.
  Writes are idempotent, so a retry after a partial attempt is safe. A wiring
  bug (unknown handler or batch) throws `UnrecoverableError`, because retrying
  can't help. Every log line binds `runId`, `jobId` and `batchKey`.
- **Dead letter.** In the worker's `failed` event, after the last attempt (or
  an unrecoverable error), the batch goes to `factory-dead-letter`, is marked
  `dead`, `$inc`s `batchesDead`, records `lastError` on the run and runs the
  finalisation check. The run ends `completed_with_errors`. A dispatch job that
  fails permanently fails the run.
- **Killed workers.** Stall recovery is explicit, validated config:
  `WORKER_LOCK_DURATION_MS` (30 s), `WORKER_STALLED_INTERVAL_MS` (15 s) and
  `WORKER_MAX_STALLED_COUNT` (2); see `src/queue/queue.constants.ts`. A dead
  worker's lock expires after the lock duration. Within the stalled interval,
  a live worker moves the job back to waiting. A job that stalls more than the
  max count is failed into the dead-letter path. These are read at import time
  (BullMQ processor options are static).
- **Config.** `WORKER_CONCURRENCY`, `JOB_ATTEMPTS`, `JOB_BACKOFF_MS` and the
  batch sizes come only from validated config. They are recorded on each run
  (`config`).

## Why a crash at each point is safe

| Crash point | Why it is safe |
|---|---|
| **Mid-read** (batch reading its `_id` range) | Nothing was written yet. The job's lock expires, the stall checker requeues it, and the range is re-read from Mongo (ranges are stable). |
| **After upsert, before `completeBatch`** | Upserts are idempotent (natural key + version guard), so the retry rewrites the same values (`unchanged`). Counters are applied only by the call that settles the batch, so nothing is double counted. |
| **Mid-dispatch** | Each page is: batch row upsert → enqueue with a deterministic job id → move `dispatchCursor`. A retry resumes after the cursor, and re-registering or re-enqueueing a page is a no-op. |
| **Worker killed** (`docker compose kill worker`) | Its active jobs stall. After `lockDuration` + `stalledInterval` they are requeued. Completed batches are settled in `run_batches` and are skipped. |
| **Redis lost state** | Resume on boot (and `POST /runs/:id/resume`) re-enqueues dispatch jobs and unsettled batches whose job is missing or dead. Live jobs are never touched. |
| **Before finalisation** | Finalisation recomputes totals from `run_batches` and is re-attempted on every settle, on dispatch completion, and on resume. |

## Key properties

- **Idempotent.** Every target write is an upsert on a unique natural key,
  guarded by `source.sourceTs`. Target documents hold no run-specific values,
  so two runs produce the same target state.
- **Resumable.** Progress is per `_id` range in `run_batches`. Killing a worker
  loses at most the in-flight range, which is retried safely.
- **Memory-bounded.** Raw data is read with cursors in `_id` ranges. Menus use
  a smaller batch (`BATCH_SIZE_MENUS`), and Redis never holds documents.
- **Fail-fast config.** The env is validated with Zod before anything boots
  (`src/config`).

See [DATA_ANALYSIS.md §5–7](./docs/DATA_ANALYSIS.md#5-indexes-and-why) for
indexes, trade-offs and scale assumptions.
