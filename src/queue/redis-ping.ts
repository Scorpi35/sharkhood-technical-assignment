import { Inject, Injectable, OnApplicationShutdown } from '@nestjs/common';
import { Redis } from 'ioredis';
import { AppConfig } from '../config/app-config';
import type { RedisPing } from '../health/health.ports';
import { redisConnectionOptions } from './redis-connection';

/**
 * A small, dedicated Redis connection for health checks (BullMQ 6's client
 * abstraction exposes no PING). No offline queue, so a ping against a stopped
 * Redis fails at once instead of waiting; ioredis keeps reconnecting in the
 * background, so health turns green again by itself when Redis is back.
 */
@Injectable()
export class RedisHealthClient implements OnApplicationShutdown {
  private readonly client: Redis;

  constructor(@Inject(AppConfig) config: AppConfig) {
    this.client = new Redis({
      ...redisConnectionOptions(config.redis.url),
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      connectionName: 'health',
    });
    this.client.on('error', () => undefined); // reported through ping(), not as unhandled events
  }

  readonly ping: RedisPing = async () => {
    if (this.client.status === 'wait') await this.client.connect();
    await this.client.ping();
  };

  async onApplicationShutdown(): Promise<void> {
    this.client.disconnect();
  }
}
