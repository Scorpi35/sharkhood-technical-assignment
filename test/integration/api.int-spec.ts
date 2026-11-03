/** The HTTP surface end to end: the real AppModule (role "all"), over real HTTP, real Redis and Mongo. */
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { resolve } from 'node:path';
import { MongoClient, ObjectId } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import pino from 'pino';
import { AppConfig } from '../../src/config/app-config';
import { parseEnv } from '../../src/config/env.schema';
import { MONGO_CLIENT } from '../../src/infra/mongo/mongo.tokens';
import { RAW_SOURCES } from '../../src/infra/seed/raw-sources';
import { DEFAULT_SEED_OPTIONS, seedRaw } from '../../src/infra/seed/seed-raw';
import { connectTestClient } from '../support/mongo';
import { startRedis, TestRedis } from '../support/redis';

const ROOT = resolve(__dirname, '../..');
const RAW_DB = 'provider_raw_api_test';

describe('HTTP API (integration)', () => {
  let mongod: MongoMemoryServer;
  let redis: TestRedis;
  let seedClient: MongoClient;
  let app: INestApplication;
  let base: string;
  const savedEnv = { ...process.env };

  const http = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
  };
  const waitForTerminal = async (runId: string) => {
    for (let i = 0; i < 600; i++) {
      const { body } = await http('GET', `/runs/${runId}`);
      if (['completed', 'completed_with_errors', 'failed'].includes(body.status)) return body;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`run ${runId} did not finish`);
  };

  beforeAll(async () => {
    [mongod, redis] = await Promise.all([MongoMemoryServer.create(), startRedis()]);
    seedClient = await connectTestClient(mongod.getUri());
    await seedRaw(seedClient.db(RAW_DB), pino({ level: 'silent' }), RAW_SOURCES, { ...DEFAULT_SEED_OPTIONS, baseDir: ROOT });

    // AppModule validates process.env exactly as in production.
    Object.assign(process.env, {
      NODE_ENV: 'test',
      APP_ROLE: 'all',
      MONGO_URI: mongod.getUri(),
      REDIS_URL: redis.url,
      RAW_DB_NAME: RAW_DB,
      TARGET_DB_NAME: `target_${new ObjectId().toHexString()}`,
      LOG_LEVEL: 'silent',
    });
    const config = new AppConfig(parseEnv(process.env));
    // Imported only now: AppConfigModule validates process.env at import time (fail-fast), like main.ts.
    const { AppModule } = await import('../../src/app.module');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRole(config)] })
      .overrideProvider(MONGO_CLIENT)
      .useFactory({ factory: () => connectTestClient(mongod.getUri()) })
      .compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.listen(0, '127.0.0.1');
    base = (await app.getUrl()).replace('[::1]', '127.0.0.1');
  });
  afterAll(async () => {
    await app?.close();
    await seedClient?.close();
    await Promise.all([mongod?.stop(), redis?.stop()]);
    process.env = savedEnv;
  });

  it('GET /health -> 200 with each dependency up and its latency', async () => {
    const { status, body } = await http('GET', '/health');
    expect(status).toBe(200);
    expect(body).toMatchObject({
      status: 'ok',
      mongo: { raw: { status: 'up', latencyMs: expect.any(Number) }, target: { status: 'up', latencyMs: expect.any(Number) } },
      redis: { status: 'up', latencyMs: expect.any(Number) },
    });
  });

  it('GET /health -> 503 while Redis does not answer, 200 once it does again', async () => {
    // CLIENT PAUSE makes Redis stop answering every other client, like a stopped/hung server.
    await redis.pause(3000);
    const down = await http('GET', '/health');
    expect(down.status).toBe(503);
    expect(down.body).toMatchObject({ status: 'down', redis: { status: 'down', error: 'no answer within 1000 ms' }, mongo: { raw: { status: 'up' } } });
    await new Promise((r) => setTimeout(r, 3000));
    expect((await http('GET', '/health')).status).toBe(200);
  });

  it('POST /runs with an invalid body -> 400 with Zod issue paths', async () => {
    const { status, body } = await http('POST', '/runs', { collections: ['menus', 'pizza'], limit: -1, batchSize: 'big', extra: true });
    expect(status).toBe(400);
    expect(body).toMatchObject({ statusCode: 400, error: 'Bad Request', message: 'Request validation failed' });
    expect(body.issues.map((i: { path: string }) => i.path).sort()).toEqual(['', 'batchSize', 'collections.1', 'limit']);
    expect((await http('POST', '/runs', '{"collections": [')).status).toBe(400); // malformed JSON
  });

  it('POST /runs -> 202, then GET /runs/:id, GET /runs/:id/errors, POST /runs/:id/resume', async () => {
    const started = await http('POST', '/runs', { collections: ['restaurants', 'menus'], batchSize: 100 });
    expect(started.status).toBe(202);
    expect(started.body).toEqual({ runId: expect.stringMatching(/^[0-9a-f-]{36}$/), status: 'dispatching' });
    const { runId } = started.body;

    const run = await waitForTerminal(runId);
    expect(run).toMatchObject({
      runId,
      status: 'completed_with_errors',
      counters: { read: 570, failed: 157 },
      sources: { xbyte_raw_restaurants: { batchesTotal: 1, batchesDone: 1 }, xbyte_raw_menus: { batchesTotal: 5, batchesDone: 5 } },
      config: { batchSizes: { xbyte_raw_restaurants: 100, xbyte_raw_menus: 100 } },
      timings: { createdAt: expect.any(String), finishedAt: expect.any(String), durationMs: expect.any(Number) },
    });
    expect(run.errorSample.length).toBeGreaterThan(0);

    // Errors: cursor pagination, reason filter, capped limit.
    const first = await http('GET', `/runs/${runId}/errors?limit=100`);
    expect(first.status).toBe(200);
    expect(first.body.items).toHaveLength(100);
    const second = await http('GET', `/runs/${runId}/errors?limit=100&cursor=${first.body.nextCursor}`);
    expect(second.body.nextCursor).toBeNull();
    const all = [...first.body.items, ...second.body.items];
    expect(new Set(all.map((e: { id: string }) => e.id)).size).toBe(all.length); // no duplicates across pages
    expect(all.filter((e) => e.severity === 'error')).toHaveLength(157);
    const provider = await http('GET', `/runs/${runId}/errors?reason=PROVIDER_ERROR&limit=1000`);
    expect(provider.status).toBe(200); // limit 1000 is capped, not rejected
    expect(provider.body.items).toHaveLength(157);
    expect(provider.body.items.every((e: { reason: string }) => e.reason === 'PROVIDER_ERROR')).toBe(true);
    expect((await http('GET', `/runs/${runId}/errors?reason=NOPE`)).body.issues[0].path).toBe('reason');
    expect(await http('GET', `/runs/${runId}/errors?cursor=not-an-id`)).toMatchObject({ status: 400, body: { message: expect.stringContaining('invalid cursor') } });

    // Resume a finished run -> 409.
    expect(await http('POST', `/runs/${runId}/resume`)).toMatchObject({ status: 409, body: { statusCode: 409, error: 'Conflict', runId } });
  });

  it('unknown runs and routes -> JSON 404s, never a stack trace', async () => {
    const id = '00000000-0000-0000-0000-000000000000';
    for (const [method, path] of [['GET', `/runs/${id}`], ['GET', `/runs/${id}/errors`], ['POST', `/runs/${id}/resume`]]) {
      expect(await http(method, path)).toEqual({ status: 404, body: { statusCode: 404, error: 'Not Found', message: `unknown run ${id}`, runId: id } });
    }
    const route = await http('GET', '/nope');
    expect(route).toMatchObject({ status: 404, body: { statusCode: 404, error: 'Not Found' } });
    expect(JSON.stringify(route.body)).not.toMatch(/\bat \S+\.(ts|js):\d+/);
  });
});
