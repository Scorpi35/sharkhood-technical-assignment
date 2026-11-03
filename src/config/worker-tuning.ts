import { envSchema } from './env.schema';

const tuningSchema = envSchema.pick({ WORKER_LOCK_DURATION_MS: true, WORKER_STALLED_INTERVAL_MS: true, WORKER_MAX_STALLED_COUNT: true });

export interface WorkerTuning {
  readonly lockDuration: number;
  readonly stalledInterval: number;
  readonly maxStalledCount: number;
}

/**
 * Worker stall settings for BullMQ's @Processor options, which are fixed when the
 * decorator runs (at import time), so they cannot come from DI. Reads the same
 * validated fields as the full env schema. If they are invalid, the defaults are
 * returned here, and AppConfigModule's validation still exits the process with
 * a readable error.
 */
export function workerTuningFromEnv(env: Record<string, unknown> = process.env): WorkerTuning {
  const parsed = tuningSchema.safeParse(env);
  const v = parsed.success ? parsed.data : tuningSchema.parse({});
  return { lockDuration: v.WORKER_LOCK_DURATION_MS, stalledInterval: v.WORKER_STALLED_INTERVAL_MS, maxStalledCount: v.WORKER_MAX_STALLED_COUNT };
}
