import { Redis } from 'ioredis';
import { GenericContainer, StartedTestContainer } from 'testcontainers';

export interface TestRedis {
  readonly url: string;
  /** Empty the test database (FLUSHDB on the URL's db only, never FLUSHALL). */
  flush(): Promise<void>;
  /** Make Redis stop answering every other client for `ms` (CLIENT PAUSE), like a hung server. */
  pause(ms: number): Promise<void>;
  stop(): Promise<void>;
}

async function command(url: string, ...args: (string | number)[]): Promise<unknown> {
  const client = new Redis(url, { maxRetriesPerRequest: 1 });
  try {
    return await client.call(String(args[0]), ...args.slice(1).map(String));
  } finally {
    client.disconnect();
  }
}

/**
 * An ephemeral Redis for integration tests: a redis:7 container (testcontainers),
 * or, if REDIS_URL is set, that server (CI service / compose, no Docker-in-Docker).
 * With REDIS_URL, point it at a disposable database (e.g. redis://localhost:6379/15):
 * tests FLUSHDB it between cases.
 */
export async function startRedis(): Promise<TestRedis> {
  const external = process.env.REDIS_URL;
  let container: StartedTestContainer | undefined;
  const url = external ?? (await (async () => {
    container = await new GenericContainer('redis:7').withExposedPorts(6379).start();
    return `redis://${container.getHost()}:${container.getMappedPort(6379)}`;
  })());
  return {
    url,
    flush: async () => void (await command(url, 'FLUSHDB')),
    pause: async (ms) => void (await command(url, 'CLIENT', 'PAUSE', ms, 'ALL')),
    stop: async () => void (await container?.stop()),
  };
}
