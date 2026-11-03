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

Configuration is validated at startup and the process exits on invalid values. See `.env.example`.
More detail for contributors is in [CLAUDE.md](./CLAUDE.md).
