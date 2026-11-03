# CLAUDE.md

Guidance for Claude Code (and humans) working in this repository.

## What this is

A NestJS service that migrates provider data from a raw MongoDB database
(`RAW_DB_NAME`, default `provider_raw`) into a target domain database
(`TARGET_DB_NAME`, default `provider_domain`). Work is processed by BullMQ jobs
on Redis. One image runs in one of three roles, chosen by `APP_ROLE`:

| Role     | Boots                                         | Used by compose service |
|----------|-----------------------------------------------|-------------------------|
| `api`    | HTTP server (`NestFactory.create`)            | `api` (port 3000)       |
| `worker` | App context only (`createApplicationContext`) | `worker`                |
| `all`    | Both, in one process (local dev default)      | none                    |

## Commands

```bash
npm run build          # nest build -> dist/
npm start              # node dist/main.js (role from APP_ROLE, default all)
npm run start:worker   # APP_ROLE=worker
npm run start:dev      # watch mode, pretty logs
npm run lint
npm test               # unit tests: src/**/*.spec.ts
npm run test:int       # integration tests: test/integration (mongodb-memory-server / testcontainers)
npm run seed           # stream data/raw/*.json into provider_raw (idempotent upsert by _id)

docker compose up --build    # mongo, redis, api, worker
docker compose run --rm api npm run seed   # same seed, from the image (data/raw mounted read-only)
docker compose kill worker   # simulate a worker crash (resumability demo)
```

## Layout

```
src/
  main.ts            # validates config first, then boots by role
  app.module.ts      # composition root: AppModule.forRole(config)
  config/            # Zod env schema, AppConfig, loader. The ONLY place that reads process.env
  logging/           # pino options (shared by app + scripts), nestjs-pino module
  health/            # GET /health (api liveness)
  worker/            # worker-side services (heartbeat for now)
  core/              # provider-agnostic, pure; no infrastructure imports (lint-enforced). See src/core/README.md
    pipeline/        #   contracts (types.ts), Stage, runPipeline, dedupe
    providers/       #   ProviderAdapter / SourceHandler, declarative FieldMapping, ProviderRegistry
    ports/           #   SourceReader, TargetWriter, Quarantine/Run/Batch repositories + Symbol DI tokens
    transform/       #   pure normalisers, TransformRegistry, mapping interpreter
  providers/         # all provider knowledge; providers.module.ts builds the ProviderRegistry
    xbyte/           #   schemas (Zod), mappings (declarative + ownership table), handlers/, adapter, module
  domain/            # one folder per target entity: *.repository.ts (versioned upserts), *.indexes.ts, *.module.ts
  infra/             # the only place besides domain/ that may import mongodb (lint-enforced)
    mongo/           #   MongoModule (one client; RAW_DB / TARGET_DB tokens), MongoSourceReader
    seed/            #   raw-sources.ts (file -> collection map) + streaming seed
scripts/             # ts-node entry points (seed-raw.ts); logic lives in src/ so it compiles into dist/
data/raw/            # provider sample files (Extended JSON arrays)
test/
  integration/       # integration tests (npm run test:int)
  fixtures/          # trimmed real samples only (api_key redacted)
  support/           # test helpers (connectTestClient: Jest/driver NODE-7832 workaround)
```

Inside Jest, always connect with `connectTestClient()` from `test/support/mongo.ts`;
a bare `MongoClient.connect` fails the handshake there (driver bug NODE-7832).

## Project rules (enforced by T01 tooling)

- **Config is validated before anything boots.** `src/config/env.schema.ts` is the
  single source of truth. Bad or missing values print a one-line JSON error with
  the flattened Zod issues and `exit(1)` before any module or connection exists.
  To add a variable, add it to the schema, `AppConfig`, `.env.example` and `docker-compose.yml`.
- **Never read `process.env` outside `src/config/`.** Inject `AppConfig`. Lint enforces this.
- **`src/core` import boundary is lint-enforced** (see Conventions below). Type-only
  `@nestjs/*` imports are allowed for DI tokens; value imports are not.
- **Logs are structured.** Use the Nest `Logger` (backed by pino), `logger.log({ ...fields }, 'message')`.
  Output is single-line JSON; pretty printing only when `NODE_ENV=development`.
  Never use `console.*`. pino also redacts `endpoint`/`requests_url` as a backstop.
- **Batch sizes come from config.** `BATCH_SIZE_MENUS` (default 25) is small because
  menu documents are about 27 KB each; everything else uses `BATCH_SIZE_DEFAULT` (200).
- **Workers run as their own containers** so they can be killed independently and
  jobs must resume safely. Keep job handlers idempotent.

## Conventions

- Layered layout: `src/core/**` is provider-agnostic and **must not import** from `src/providers/**`, `src/domain/**`, `mongodb`, `bullmq` or `@nestjs/*` (except types used in DI tokens). Enforce this with an ESLint `no-restricted-imports` rule.
- Transform code is **pure**: no `Date.now()`, `Math.random()`, I/O or module-level mutable state. Timestamps come from the source document (`createdAt`).
- Target documents never contain run-specific values (runId, wall-clock time). Run metadata lives only in `runs` / `run_batches` / `quarantine`. This is what makes "two runs → identical target state" literally true.
- Error taxonomy: `DocumentError` (bad data → quarantine, continue) vs everything else (infrastructure → throw, BullMQ retries). Transformers return results; they never throw `DocumentError`.
- Logs: structured pino JSON. Always bind `runId`, `jobId`, `batchKey` and, where relevant, `rawCollection`/`sourceId`. Never log `endpoint`/`requests_url`.
- Tests sit next to the code (`*.spec.ts`); integration tests go in `test/integration`. Fixtures in `test/fixtures` are **trimmed real samples**, not invented data.
- Conventional commits (`feat:`, `test:`, `docs:`). One ticket = one PR.

---

## Data findings (reference for every ticket)

These come from profiling the three sample files. T03 puts them into the repo, and T06/T07 implement them. Claude should treat this section as the source of truth.

### Shared envelope (all three collections)
`{ _id:{$oid}, domain:"talabat", endpoint, params?, payload:{ request_log:{requests_url, request_time, request_process_time, statusCode}, ... }, statusCode, createdAt:{$date}, updatedAt:{$date}, __v }`
- Files are **MongoDB Extended JSON** (`$oid`, `$date`). They must be parsed with `EJSON`, not `JSON.parse`.
- `endpoint` / `requests_url` **contain a live provider API key**. Never copy them into target collections, logs or quarantine excerpts.
- `request_process_time` is a numeric **string**. `request_time` is a naive local timestamp, while `crt` is UTC. Use `createdAt` as the source timestamp.
- `statusCode` is always 200, **even for error payloads**. Errors live in the payload body.

### `xbyte-raw-locations` (8 docs)
- `payload.results[] = {location_name, location_slug, location_id:int}`.
- The 8 docs are **identical snapshots** of the same 697 locations (5,576 rows → 697 unique).
- `location_slug` is **not unique**: 8 slugs map to several ids (e.g. `industrial-area` → 1916, 5625, 3892; `al-soor` → 1560, 6831). There is no city/country field. **Natural key = `location_id`.**

### `xbyte-raw-restaurants` (70 docs): area listing pages
- `params = {domain, areaSlug, areaId:"1468" (string!), page_no:int}`; `payload["Total Page"]`, `payload.results[] = {area_name, restaurant_name, restaurant_url}`.
- Only 2 areas (al-zaab ×54 docs, al-rowdah ×16). The same `(area, page_no)` was **fetched up to 4 times, and the contents differ between fetches** (pagination is unstable).
- `"Total Page"` is 227 for both areas, so it is meaningless. One doc has `{"Total Page":1, "Page Error Message":"Page limit exceeded."}` with no results. One doc has `{"error":""}` with no results. Short pages (14 or 8 rows) appear mid-sequence.
- 1,011 rows → **302 unique restaurants**. **161 appear in both areas**. The URL slug often names a different area than the listing (e.g. `…/648607/sla-restaurant-and-cafe-al-rowdah?aid=1468` listed under Al Zaab). So a listing row means **"delivers to area"**, not "located in area": it is a many-to-many coverage relation.
- The restaurant id lives **only inside the URL**: `/restaurant/{outletId}/{slug}?aid={areaId}`. Country segment is `uae`.
- Names have trailing spaces, double spaces, Arabic comma `،`, en dash, accented characters.

### `xbyte-raw-menus` (500 docs, 13.7 MB, ~27 KB/doc)
- `params.restaurant_url`. **155/500 (31%) are `{Message:"This is not restaurant page (Talabat)."}`** with no results.
- `payload.results` is always an array of exactly 1, so unwrap it.
- Restaurant fields: `id, name, logo, latitude:"str", longitude:"str", rate:int|float, totalReviews (always 0), totalRatings, deliveryFee:"9"|"6.5", DeliveryTime:"25-40 mins"|"30 mins", "Minimum Order":int, "Restaurant Address", City (always "Dubai"), Contact (always placeholder "00000-00000"), outletCode:int, category[]`. Key naming is inconsistent: spaces, PascalCase and camelCase all appear.
- **`payload.id` ≠ URL id. `outletCode` == URL id (345/345).** So `outletCode` is the join key to the restaurants listing, and `id` is a separate provider vendor id. Keep both.
- All menu URLs use `aid=1280` (DWTC), which is the scrape context, not the branch location. **0 of 500 menu outlets appear in the restaurants sample**, so joins must tolerate orphans in both directions.
- `category[] = {category_id, category_name, items[]}`; `items[] = {item_id, item_name, description, price:int|float, rating:int, image:str|null}`.
- **"Picks for you 🔥"** appears in 256 restaurants. It is a synthetic, curated category. In 58 restaurants its `category_id` **collides with a real category's id** (e.g. 2796833705 = both "Picks for you" and "Bites"). 2,118 items appear in more than one category, mostly Picks plus their real category.
- 31,102 item rows → 28,773 unique `item_id`s. No item is shared across restaurants.
- Prices: float32 noise (`50.80000076293945`), 1,985 zero prices. `rating` is 0 on 93% of items (0 means "unrated"). 1,631 `image:null`, 2,071 empty descriptions.

### Target model (decided; T03 documents it, T07 builds it)
| Collection | Natural key (unique index) | Owns | Notes |
|---|---|---|---|
| `areas` | `(platform, externalId)` ← `location_id` | name, slug | slug gets a non-unique index |
| `restaurants` | `(platform, externalId)` ← outletCode / URL id | name, slug, url, vendorId, geo, rating, delivery terms, address, logo | written by **two sources with disjoint field ownership** (see T06) |
| `restaurant_areas` | `(platform, restaurantExternalId, areaExternalId)` | firstSeenAt, lastSeenAt | unbounded M:N, so it gets its own collection rather than an embedded array |
| `menus` | `(platform, restaurantExternalId)` | ordered categories `{categoryId, name, position, itemIds[]}`, `featuredItemIds[]` | embedding is bounded (≈12 categories × id refs) |
| `menu_items` | `(platform, restaurantExternalId, itemId)` | name, description, priceMinor, currency, rating, imageUrl, categoryIds[], isFeatured, isAvailable | first-class: largest volume, queried independently |

- The key is `platform` ("talabat"), **not** provider ("xbyte"). That way a second provider that scrapes the same platform converges on the same entities. Every target doc also carries `source: {provider, rawCollection, rawId, sourceTs}`.
- Money is stored as integer minor units: `priceMinor = Math.round(price * 100)`, with `currency: "AED"` derived from the `uae` URL segment via the mapping.
- `geo` is a GeoJSON Point `[lng, lat]` with a `2dsphere` index.
