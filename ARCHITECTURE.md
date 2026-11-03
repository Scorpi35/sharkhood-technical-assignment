# Architecture

How the migration service is put together. For the data itself (source shapes,
anomalies, the target model and the reasoning behind it), read
**[docs/DATA_ANALYSIS.md](./docs/DATA_ANALYSIS.md)** first.

> Status: T01–T06 are built (bootstrap, raw seed, core pipeline, transforms, xbyte provider). Sections marked
> *planned* describe the design that later tickets implement.

## Components

```mermaid
flowchart LR
    files["data/raw/*.json<br/>(Extended JSON)"] -- "npm run seed<br/>(stream + upsert by _id)" --> raw[("Mongo<br/>provider_raw")]
    api["api<br/>APP_ROLE=api"] -- "plan run: _id ranges (planned)" --> redis[("Redis<br/>BullMQ")]
    redis -- "jobs: {runId, rawCollection, fromId, toId}" --> worker["worker(s)<br/>APP_ROLE=worker"]
    worker -- "cursor over _id range" --> raw
    worker -- "idempotent upserts" --> target[("Mongo<br/>provider_domain")]
    worker -- "runs / run_batches / quarantine" --> target
```

| Component | Runs as | Responsibility |
|---|---|---|
| `api` | `APP_ROLE=api` (HTTP, port 3000) | Health today. *Planned:* start runs, report progress, page through quarantine. |
| `worker` | `APP_ROLE=worker` (no HTTP; one or more containers) | *Planned:* process `_id`-range jobs: read raw, transform, upsert target. A separate container, so `docker compose kill worker` can demonstrate resumability. |
| seed | `npm run seed` | Streams the sample files into `provider_raw` (T02) |
| Mongo | `mongo:7` | `provider_raw` (source, read-only by convention) and `provider_domain` (target + run metadata) |
| Redis | `redis:7` | BullMQ queues. Holds job *ranges* only, never documents. |

## Layers

| Path | Contains | May import |
|---|---|---|
| `src/core/**` | Provider-agnostic, pure logic and interfaces | Not `src/providers`, `src/domain`, `mongodb`, `bullmq` or `@nestjs/*` values (lint-enforced) |
| `src/providers/**` | Per-provider knowledge: Zod schemas, declarative mappings, source handlers (xbyte, T06) | core, domain |
| `src/domain/**` *(planned)* | Target collections, upsert writers, indexes (T07) | core |
| `src/config`, `src/logging`, `src/seed` | Infrastructure | anything |

Transforms are pure. They don't call `Date.now()` or `Math.random()`, do no I/O
and hold no module-level state, so the same raw document always maps to the same
target document. Bad data surfaces as a `DocumentError` result, which goes to
quarantine and lets the run continue. Infrastructure failures throw, and BullMQ
retries them.

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
