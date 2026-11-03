/** Each resolves when its dependency answers a ping, rejects otherwise. Implemented in infra (Mongo) and queue (Redis). */
export const MONGO_PING = Symbol('MongoPing');
export interface MongoPing {
  raw(): Promise<void>;
  target(): Promise<void>;
}

export const REDIS_PING = Symbol('RedisPing');
export type RedisPing = () => Promise<void>;
