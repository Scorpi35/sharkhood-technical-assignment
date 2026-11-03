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
More detail for contributors is in [CLAUDE.md](./CLAUDE.md).
