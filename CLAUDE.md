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
npm run test:int       # integration tests: test/**/*.int-spec.ts (mongodb-memory-server / testcontainers)
npm run seed

docker compose up --build    # mongo, redis, api, worker
docker compose kill worker   # simulate a worker crash (resumability demo)
```

## Layout

```
src/
  main.ts            # validates config first, then boots by role
  app.module.ts      # composition root: AppModule.forRole(config)
  config/            # Zod env schema, AppConfig, loader. The ONLY place that reads process.env
  logging/           # nestjs-pino setup
  health/            # GET /health (api liveness)
  worker/            # worker-side services (heartbeat for now)
  core/              # pure domain logic, no infrastructure imports (lint-enforced)
  scripts/           # CLI entry points (seed)
test/                # integration tests
```

## Project rules (enforced by T01 tooling)

- **Config is validated before anything boots.** `src/config/env.schema.ts` is the
  single source of truth. Bad or missing values print a one-line JSON error with
  the flattened Zod issues and `exit(1)` before any module or connection exists.
  To add a variable, add it to the schema, `AppConfig`, `.env.example` and `docker-compose.yml`.
- **Never read `process.env` outside `src/config/`.** Inject `AppConfig`. Lint enforces this.
- **`src/core` stays pure.** No `mongodb`, `bullmq`, `ioredis` or `@nestjs/*` imports
  there (lint: `@typescript-eslint/no-restricted-imports`). Core defines interfaces;
  adapters outside core implement them.
- **Logs are structured.** Use the Nest `Logger` (backed by pino), `logger.log({ ...fields }, 'message')`.
  Output is single-line JSON; pretty printing only when `NODE_ENV=development`.
  Never use `console.*`.
- **Batch sizes come from config.** `BATCH_SIZE_MENUS` (default 25) is small because
  menu documents are about 27 KB each; everything else uses `BATCH_SIZE_DEFAULT` (200).
- **Workers run as their own containers** so they can be killed independently and
  jobs must resume safely. Keep job handlers idempotent.

## Conventions

<!--
  TODO(T01): paste the "Conventions" section from the assignment spec here VERBATIM.
  It was not in the T01 ticket body, so it has not been copied yet.
-->

_Pending: to be copied verbatim from the assignment spec._

## Data findings

<!--
  TODO(T01): paste the "Data findings" section from the assignment spec here VERBATIM.
-->

_Pending: to be copied verbatim from the assignment spec._
