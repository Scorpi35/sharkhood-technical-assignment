import type { RedisOptions } from 'bullmq';

/**
 * ioredis options from the validated REDIS_URL (redis:// or rediss://).
 * maxRetriesPerRequest must be null for BullMQ workers (blocking commands).
 */
export function redisConnectionOptions(url: string): RedisOptions {
  const u = new URL(url);
  const db = u.pathname.length > 1 ? Number(u.pathname.slice(1)) : 0;
  return {
    host: u.hostname,
    port: u.port ? Number(u.port) : 6379,
    ...(u.username ? { username: decodeURIComponent(u.username) } : {}),
    ...(u.password ? { password: decodeURIComponent(u.password) } : {}),
    db: Number.isInteger(db) ? db : 0,
    ...(u.protocol === 'rediss:' ? { tls: {} } : {}),
    maxRetriesPerRequest: null,
  };
}
