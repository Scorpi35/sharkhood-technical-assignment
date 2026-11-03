import type { AppRole, Env } from './env.schema';

/**
 * Typed, immutable application configuration. Inject this class; never read
 * process.env outside src/config (enforced by lint).
 */
export class AppConfig {
  readonly nodeEnv: Env['NODE_ENV'];
  readonly isDevelopment: boolean;
  readonly role: AppRole;
  readonly logLevel: Env['LOG_LEVEL'];
  readonly http: { readonly port: number };
  readonly mongo: { readonly uri: string; readonly rawDbName: string; readonly targetDbName: string };
  readonly redis: { readonly url: string };
  readonly jobs: { readonly concurrency: number; readonly attempts: number; readonly backoffMs: number };
  readonly worker: { readonly lockDurationMs: number; readonly stalledIntervalMs: number; readonly maxStalledCount: number };
  readonly batch: { readonly defaultSize: number; readonly menusSize: number };
  readonly errorSampleSize: number;

  constructor(env: Env) {
    this.nodeEnv = env.NODE_ENV;
    this.isDevelopment = env.NODE_ENV === 'development';
    this.role = env.APP_ROLE;
    this.logLevel = env.LOG_LEVEL;
    this.http = { port: env.PORT };
    this.mongo = { uri: env.MONGO_URI, rawDbName: env.RAW_DB_NAME, targetDbName: env.TARGET_DB_NAME };
    this.redis = { url: env.REDIS_URL };
    this.jobs = {
      concurrency: env.WORKER_CONCURRENCY,
      attempts: env.JOB_ATTEMPTS,
      backoffMs: env.JOB_BACKOFF_MS,
    };
    this.worker = {
      lockDurationMs: env.WORKER_LOCK_DURATION_MS,
      stalledIntervalMs: env.WORKER_STALLED_INTERVAL_MS,
      maxStalledCount: env.WORKER_MAX_STALLED_COUNT,
    };
    this.batch = { defaultSize: env.BATCH_SIZE_DEFAULT, menusSize: env.BATCH_SIZE_MENUS };
    this.errorSampleSize = env.ERROR_SAMPLE_SIZE;
    Object.freeze(this);
  }

  get runsHttp(): boolean {
    return this.role === 'api' || this.role === 'all';
  }

  get runsWorker(): boolean {
    return this.role === 'worker' || this.role === 'all';
  }
}
