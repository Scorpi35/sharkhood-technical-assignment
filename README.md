# Sharkhood Technical Assignment: provider data factory

A NestJS service that migrates scraped provider data (xbyte / talabat) from a
raw MongoDB database into a clean, deduplicated domain model. Runs are split
into `_id`-range batches processed by BullMQ workers. Every write is an
idempotent, version-guarded upsert, so running twice changes nothing, and a
worker can be killed mid-run without losing or duplicating work.

Start with **[docs/DATA_ANALYSIS.md](./docs/DATA_ANALYSIS.md)** (what the data
looks like and why the model is shaped this way). Then read
**[ARCHITECTURE.md](./ARCHITECTURE.md)** (how it runs).

## Quickstart

Requires Docker only.

```bash
docker compose up -d --build                   # mongo, redis, api (:3000), worker
docker compose run --rm api npm run seed       # load the 3 sample files into provider_raw
curl -XPOST localhost:3000/runs                # -> {"runId":"<id>","status":"dispatching"}
curl localhost:3000/runs/<id>                  # status, per-source progress, counters, timings
```

The run finishes in about 2 s as **`completed_with_errors`**: the sample
contains 157 provider error pages (155 "not a restaurant page" menus and 2
listing errors). They are quarantined, not dropped, and each is visible at
`GET /runs/<id>/errors`. Expected counters: `read 578`, `transformed 30925`,
`failed 157`, `warnings 23`.

| Target collection | Documents |
|---|---|
| `areas` | 697 |
| `restaurants` | 647 |
| `restaurant_areas` | 463 |
| `menus` | 345 |
| `menu_items` | 28,773 |

## HTTP API

Also available as [`requests.http`](./requests.http). Errors are JSON
`{statusCode, error, message, runId?}` and never contain stack traces.

```bash
# start a run (all sources, or a subset); 202 {runId, status}
curl -s -X POST localhost:3000/runs -H 'content-type: application/json' \
  -d '{"collections": ["restaurants", "menus"], "limit": 100, "batchSize": 50}'

# the run: status, per-source progress, counters, timings, errorSample (404 if unknown)
curl -s localhost:3000/runs/<runId>

# quarantined errors, cursor-paginated (limit default 50, max 200), optional ?reason=
curl -s 'localhost:3000/runs/<runId>/errors?reason=PROVIDER_ERROR&limit=50'
curl -s 'localhost:3000/runs/<runId>/errors?cursor=<nextCursor>'

# re-enqueue work missing from Redis (202; 409 if the run already finished)
curl -s -X POST localhost:3000/runs/<runId>/resume

# readiness: Mongo raw + target and Redis, each with up|down and latency (503 if any is down)
curl -s -w ' %{http_code}\n' localhost:3000/health
```

Body rules for `POST /runs`:
- `collections`: any of `locations`, `restaurants`, `menus` (the registered source aliases);
- `limit`: a positive integer;
- `batchSize`: a positive integer up to 5000.

Unknown keys are rejected. Invalid input gets a `400` listing each Zod issue's `path`.

The same is available from the CLI:
- `docker compose run --rm api npm run migrate` starts a run, waits for it and prints the counters;
- `npm run fingerprint` hashes the target collections.

## Tests

```bash
npm test            # unit tests (no services needed)
npm run test:int    # integration tests: needs only Docker
```

Integration tests start their own **Mongo** (mongodb-memory-server) and
**Redis** (a `redis:7` container via testcontainers). In CI or compose, without
Docker-in-Docker, set `REDIS_URL` and that server is used instead. Point it at
a **disposable database index** (e.g. `REDIS_URL=redis://localhost:6379/15`):
the tests `FLUSHDB` it, and never touch other databases.

`test/integration/factory.int-spec.ts` is the end-to-end test. It boots the real
app (`APP_ROLE=all`, batch size 3) and seeds the fixtures plus real duplicate
snapshots. It then checks, over HTTP:
1. a full run: exact counters, target counts, the "Picks"/"Bites" collision, a
   float-noise price, and quarantine without the API key;
2. a second run: `written: 0` and an identical fingerprint;
3. a worker force-killed after 2 batches: a fresh worker finishes the run
   through stall recovery, completed batches are not re-run, and the
   fingerprint is the same.

CI (`.github/workflows/ci.yml`) runs lint, the unit tests and the build on
every push and pull request. That includes `src/docs-consistency.spec.ts`,
which fails if the docs and the code disagree on indexes, quarantine reasons,
counters, statuses or env vars.

## Idempotency proof

```bash
docker compose run --rm api npm run migrate       # run 1: written = transformed
docker compose run --rm api npm run fingerprint   # sha256 per target collection
docker compose run --rm api npm run migrate       # run 2: "written": 0, "unchanged": 30925
docker compose run --rm api npm run fingerprint   # identical hashes
```

Target documents contain nothing run-specific: no run ids and no wall-clock
time; `firstSeenAt`, `lastSeenAt` and `source.sourceTs` come from the raw data.
An integration test scans every target document to enforce this. The
fingerprint streams each collection in natural-key order, drops `_id`,
stable-stringifies each document and hashes the result.

## Resumability demo (kill the worker)

1. Empty the target and keep the indexes:
   `docker compose exec mongo mongosh provider_domain --eval 'for (const c of ["areas","restaurants","restaurant_areas","menus","menu_items"]) db.getCollection(c).deleteMany({})'`
2. Start a run with small menu batches, so it lasts longer, and kill the worker straight away:
   `docker compose run --rm -e BATCH_SIZE_MENUS=5 api npm run migrate -- --no-wait && docker compose kill worker`
3. Check that the run is mid-flight:
   `docker compose exec mongo mongosh provider_domain --eval 'db.run_batches.aggregate([{$group:{_id:"$status",n:{$sum:1}}}])'`
   Note the completed batches' `attempts`.
4. `docker compose start worker`. Within about 45 s (lock expiry + stall check), the run completes.
5. Verify:
   - completed batches still have the same `attempts`;
   - only the batches that were active at the kill show `attempts: 2`;
   - `npm run fingerprint` equals a clean run's.

   If Redis was lost, `POST /runs/<id>/resume` (or a worker restart) re-enqueues the missing work.

Measured on Docker: the run was killed with 26 batches completed and 2 active.
After restart, the 26 kept `attempts 1`, only the 2 in-flight batches were
re-run, and the fingerprint matched the clean run's.

## Configuration

Everything is an environment variable, validated with Zod at startup. An
invalid value exits with a readable error before anything connects.
[`.env.example`](./.env.example) lists them all with their defaults:
- connection strings and database names;
- `APP_ROLE` (`api` | `worker` | `all`);
- batch sizes;
- `WORKER_CONCURRENCY`, `JOB_ATTEMPTS`, `JOB_BACKOFF_MS`;
- the stall-recovery timings;
- `ERROR_SAMPLE_SIZE` and `LOG_LEVEL`.

Logs are single-line JSON (pretty only with `NODE_ENV=development`).

## Decisions and why

The full reasoning is in [DATA_ANALYSIS.md](./docs/DATA_ANALYSIS.md) §3
(anomalies), §4 (target model) and §6 (trade-offs). The main calls:

- **Entities are keyed on the platform (talabat), not the provider (xbyte).**
  A second scraper of the same platform converges on the same records.
  `source.provider` records who wrote what.
- **Two writers, disjoint fields.** Listings and menus both write
  `restaurants`, but each field has exactly one owner (`listing.name` vs
  `name`), with a version per writer. Order doesn't matter.
- **Version-guarded upserts** (`sourceTs|rawId`, compared with `≤`). An older
  raw document can never overwrite newer data. A re-run is a no-op
  (`unchanged`); an out-of-date one is `stale`.
- **"Picks for you" is a flag, not a category.** It is synthetic and collides
  with real category ids, so it becomes `isFeatured` / `featuredItemIds`.
  Real categories that share an id are merged, with a warning.
- **Coverage is its own collection.** `restaurant_areas` is a union of
  observations (`$min`/`$max` seen times), because listing pagination is
  unstable.
- **Failure granularity.** An error page rejects its document; a bad element
  drops only its record; repairs are warnings. Nothing bad is silently
  dropped: it goes to quarantine with a reason.
- **Redis holds ranges, never documents.** Progress lives in Mongo, so Redis
  can be lost and rebuilt (`resume`).
- **Values.** Money is integer minor units; a rating of 0 becomes `null`
  (unrated); placeholder contacts become `null`; all ids are canonical strings.

## Known gaps

- **Zero-price items** (1,859) are kept as `priceMinor: 0`, but not flagged
  per run. Find them with `menu_items.find({priceMinor: 0})`.
- **Dead batches** can't be replayed through the API. `resume` re-enqueues only
  unsettled work. A new run reprocesses everything idempotently, which is cheap
  but not targeted.
- **Mongo down at a final failure.** If Mongo is unreachable exactly when a
  batch exhausts its attempts, marking it dead fails too. The batch stays
  unsettled until a worker restart or `POST /runs/:id/resume` picks it up again.
- **Coverage only grows.** An area that stops listing a restaurant is not
  removed (`lastSeenAt` stops advancing).
- **The address area is not resolved to an area id** (DATA_ANALYSIS §8, open question 4).
- **Standalone Mongo, no transactions.** Correctness relies on idempotent
  upserts and on finalisation recomputing totals from `run_batches`.
- **The API has no authentication, rate limiting or `GET /runs` list.** The
  worker has no HTTP health check (a heartbeat file drives its Docker
  healthcheck).
- **Every run is a full rescan** of the selected collections. There is no
  incremental ingestion.
- **The test suite is larger than the "10–20 tests" guideline**: 151 cases in
  23 suites, none of them snapshots. Several were mutation-checked to prove
  they catch real regressions.
- **testcontainers is pinned to 11.x**, because 12.x needs Node ≥ 22.19 and
  this was developed on Node 20.

## With another week

- **A second provider adapter**, to prove the seam (`ARCHITECTURE.md` → "How to
  add a provider") and the platform keying under real convergence.
- **Change-data capture** (change streams or `updatedAt` watermarks) instead of
  full rescans.
- **OpenTelemetry** traces and metrics (batch latency, queue depth, quarantine
  rate), not just structured logs.
- **Per-field lineage:** which raw document last wrote each field.
- **A read-only Mongo role** for the raw database, so "read-only by
  construction" also holds at the database level.
- **Contract tests per provider mapping**, against a fresh sample, to catch
  scraper format changes early.
- **A menu-item history collection** (price and availability over time) instead
  of only the latest snapshot.
- **Batch replay:** `POST /runs/:id/batches/:key/retry` for dead batches.

## Security note

The raw sample data contains a **live provider API key** in `endpoint` and
`payload.request_log.requests_url`. The factory never copies it: Zod schemas
strip those fields, issue details are sanitized, logs redact them, and tests
assert that the key appears in no target document, quarantine entry or run.
The samples are committed only because they were supplied for this exercise.
**The key should be rotated** before this repository is shared beyond the
reviewers. The test fixtures are trimmed real samples with the key replaced
by `REDACTED`.

## Documentation

- [docs/DATA_ANALYSIS.md](./docs/DATA_ANALYSIS.md): source shapes, relationships,
  anomalies, target model, indexes, trade-offs, scale assumptions.
- [ARCHITECTURE.md](./ARCHITECTURE.md): module map, pipeline stages, queue
  topology, run states, counters, crash safety, how to add a provider.
- [SUBMISSION.md](./SUBMISSION.md): what was built, what was left out, where to look first.
- [CLAUDE.md](./CLAUDE.md): conventions for contributors.
