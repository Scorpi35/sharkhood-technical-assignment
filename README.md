# Provider Data Factory

A NestJS + MongoDB + BullMQ service that transforms raw provider data (xbyte / talabat) in `provider_raw` into a clean domain model in `provider_domain`. Runs are idempotent and resumable.

More detail: [docs/DATA_ANALYSIS.md](./docs/DATA_ANALYSIS.md) (data and model) · [ARCHITECTURE.md](./ARCHITECTURE.md) (pipeline and queues).

## Setup and run

Requires Docker. Configuration is through environment variables, validated at startup. See [`.env.example`](./.env.example).

```bash
# Setup: start mongo, redis, api (:3000) and worker
docker compose up -d --build --wait

# Seed: load the 3 sample files into provider_raw
docker compose run --rm api npm run seed

# Run: trigger a run (optional body: {"collections":["menus"],"limit":100,"batchSize":50})
curl -X POST localhost:3000/runs                    # -> {"runId":"<id>"}

# Observe: status and counters, quarantined documents, Mongo/Redis health
curl localhost:3000/runs/<id>
curl "localhost:3000/runs/<id>/errors?limit=50"
curl localhost:3000/health
```

More examples are in [`requests.http`](./requests.http).

Expected result: `completed_with_errors`, with 157 provider error pages quarantined.

**Domain data** (`provider_domain`):

| Collection | Documents | Contents |
|---|---|---|
| `areas` | 697 | Delivery areas |
| `restaurants` | 647 | One per outlet |
| `restaurant_areas` | 463 | Which restaurant delivers to which area |
| `menus` | 345 | Category structure and featured items per restaurant |
| `menu_items` | 28,773 | One per dish |

**Run bookkeeping** (`provider_domain`):

| Collection | Contents |
|---|---|
| `runs` | One per run: status, counters, timings, error sample |
| `run_batches` | Status of each queued batch, used for resuming |
| `quarantine` | Rejected documents and records, each with a reason |

## Test

```bash
npm test            # unit tests
npm run test:int    # integration tests (needs Docker)
```

**Idempotency:** run twice. The second run reports `written: 0`.
```bash
docker compose run --rm api npm run migrate
docker compose run --rm api npm run fingerprint    # same hashes after each run
```

**Resumability:** kill the worker mid-run, then restart it. The run completes, and only in-flight batches are retried.
```bash
docker compose run --rm -e BATCH_SIZE_MENUS=5 api npm run migrate -- --no-wait && docker compose kill worker
docker compose start worker
```

## Decisions and why

- **Keyed on the platform (talabat), not the provider (xbyte)**, so a second scraper of the same platform updates the same records.
- **Version-guarded upserts**, so older data never overwrites newer data and re-runs change nothing.
- **Listings and menus own different restaurant fields**, so processing order doesn't matter.
- **"Picks for you" is a flag, not a category.** It's synthetic and reuses real category ids.
- **Coverage (`restaurant_areas`) is its own collection.** It's many-to-many, and the listing pages are unstable.
- **Bad data is quarantined with a reason**, never silently dropped.
- **Redis holds only ID ranges. Progress lives in Mongo**, so a lost worker or Redis can recover.
- **Money is stored in minor units.** Rating 0 and placeholder contacts become `null`.

## Known gaps

- Zero-price items (1,859) are kept but not flagged.
- Dead batches can't be replayed individually. A new run reprocesses everything.
- Every run is a full rescan. There is no incremental ingestion.
- Coverage only grows. Removed listings aren't deleted.
- No transactions (standalone Mongo).
- The sample data contains a live provider API key. It's never copied to output, but it should be rotated.

## With another week

- A second provider adapter, to prove the extension point.
- Incremental ingestion (change streams).
- OpenTelemetry metrics and traces.
- A read-only Mongo role for the raw database.
- Menu-item price history.
- Replay for single dead batches.