import { Inject, Injectable } from '@nestjs/common';
import { AppConfig } from '../config/app-config';
import { MONGO_PING, MongoPing, REDIS_PING, RedisPing } from './health.ports';

export const PING_TIMEOUT_MS = 1000;

export interface DependencyHealth {
  readonly status: 'up' | 'down';
  readonly latencyMs: number;
  readonly error?: string;
}

export interface HealthReport {
  readonly status: 'ok' | 'down';
  readonly role: string;
  readonly uptimeSec: number;
  readonly mongo: { readonly raw: DependencyHealth; readonly target: DependencyHealth };
  readonly redis: DependencyHealth;
}

/** Thrown when any dependency is down; the exception filter answers 503 with the report as the body. */
export class HealthCheckFailedError extends Error {
  override readonly name = 'HealthCheckFailedError';
  constructor(readonly report: HealthReport) {
    super('a dependency is down');
  }
}

/**
 * Readiness: pings Mongo (raw and target databases) and Redis concurrently,
 * each bounded by PING_TIMEOUT_MS. A hung connection (e.g. Redis stopped, with
 * the client queueing commands) therefore reports "down" after 1s, not never.
 */
@Injectable()
export class HealthService {
  constructor(
    @Inject(MONGO_PING) private readonly mongo: MongoPing,
    @Inject(REDIS_PING) private readonly redis: RedisPing,
    private readonly config: AppConfig,
  ) {}

  async check(): Promise<HealthReport> {
    const [raw, target, redis] = await Promise.all([timed(() => this.mongo.raw()), timed(() => this.mongo.target()), timed(this.redis)]);
    const report: HealthReport = {
      status: [raw, target, redis].every((d) => d.status === 'up') ? 'ok' : 'down',
      role: this.config.role,
      uptimeSec: Math.round(process.uptime()),
      mongo: { raw, target },
      redis,
    };
    if (report.status !== 'ok') throw new HealthCheckFailedError(report);
    return report;
  }
}

async function timed(ping: () => Promise<void>, timeoutMs = PING_TIMEOUT_MS): Promise<DependencyHealth> {
  const started = performance.now();
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      ping(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`no answer within ${timeoutMs} ms`)), timeoutMs);
      }),
    ]);
    return { status: 'up', latencyMs: Math.round(performance.now() - started) };
  } catch (err) {
    return { status: 'down', latencyMs: Math.round(performance.now() - started), error: (err as Error).message };
  } finally {
    clearTimeout(timer);
  }
}
