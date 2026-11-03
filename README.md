# Sharkhood Technical Assignment

NestJS service that migrates provider data between MongoDB databases using BullMQ workers.

## Quick start

```bash
docker compose up --build        # mongo, redis, api (:3000), worker
curl localhost:3000/health
```

Local, without Docker for the app:

```bash
cp .env.example .env
npm install
npm run build && npm start
```

## Seed the raw database

Loads `data/raw/xbyte-raw-{locations,restaurants,menus}.json` into `provider_raw`
(`xbyte_raw_locations` / `xbyte_raw_restaurants` / `xbyte_raw_menus`). It streams the files and
upserts by `_id`, so it is safe to re-run: the counts stay 8 / 70 / 500.

```bash
docker compose up -d mongo redis && docker compose run --rm api npm run seed
```

Without Docker for the app (needs `MONGO_URI` / `REDIS_URL`, e.g. from `.env`): `npm run seed`.

Configuration is validated at startup and the process exits on invalid values. See `.env.example`.

## Run a migration

```bash
docker compose run --rm api npm run migrate        # starts a run, waits, prints counters
docker compose run --rm api npm run fingerprint    # sha256 per target collection
```

**Idempotency, observably:** run `migrate` twice. The second run reports
`written: 0, unchanged: N` (N = `transformed`), and `fingerprint` prints the same
hashes before and after.

## HTTP API

Also available as [`requests.http`](./requests.http). Errors are JSON
`{statusCode, error, message, runId?}` and never contain stack traces.

```bash
# start a run (all sources, or a subset), 202 {runId, status}
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

## Resumability check (manual)

1. Empty the target and keep the indexes:
   `docker compose exec mongo mongosh provider_domain --eval 'for (const c of ["areas","restaurants","restaurant_areas","menus","menu_items"]) db.getCollection(c).deleteMany({})'`
2. Start a run with small menu batches, so it lasts longer, and kill the worker straight away:
   `docker compose run --rm -e BATCH_SIZE_MENUS=5 api npm run migrate -- --no-wait && docker compose kill worker`
3. Check that the run is mid-flight: `db.run_batches.aggregate([{$match:{runId:"<id>"}},{$group:{_id:"$status",n:{$sum:1}}}])`, then note the completed batches' `attempts`.
4. `docker compose start worker`. Within about 45 s (lock expiry + stall check), the run completes.
5. Verify:
   - completed batches still have the same `attempts`;
   - only the batches that were active at the kill show `attempts: 2`;
   - `npm run fingerprint` equals a clean run's.

   If Redis was lost, `POST /runs/<id>/resume` (or a worker restart) re-enqueues the missing work.

## Tests

```bash
npm test            # unit tests (no services needed)
npm run test:int    # integration tests: needs only Docker
```

Integration tests start their own **Mongo** (mongodb-memory-server) and
**Redis** (a `redis:7` container via testcontainers). In CI or compose, without
Docker-in-Docker, set `REDIS_URL` and that server is used instead. Point it at a
**disposable database index** (e.g. `REDIS_URL=redis://localhost:6379/15`):
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

## Documentation

- **[docs/DATA_ANALYSIS.md](./docs/DATA_ANALYSIS.md)**: source shapes, relationships, anomalies, target model, indexes and trade-offs. Start here.
- [ARCHITECTURE.md](./ARCHITECTURE.md): components, layers and key properties
- [CLAUDE.md](./CLAUDE.md): conventions for contributors
