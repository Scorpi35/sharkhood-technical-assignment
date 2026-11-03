import { z } from 'zod';

/**
 * Treat empty strings as "not set". `FOO=` in a .env or compose file otherwise
 * slips past `required` checks, and z.coerce.number() turns '' into 0.
 */
const blankAsUndefined = (v: unknown): unknown => (typeof v === 'string' && v.trim() === '' ? undefined : v);

const required = (iss: { input: unknown }) => (iss.input === undefined ? 'is required' : undefined);

const str = () => z.preprocess(blankAsUndefined, z.string({ error: required }));
const posInt = () =>
  z.preprocess(
    blankAsUndefined,
    z.coerce
      .number({ error: 'must be an integer' })
      .int({ error: 'must be an integer' })
      .min(1, { error: 'must be >= 1' }),
  );

export const APP_ROLES = ['api', 'worker', 'all'] as const;
export type AppRole = (typeof APP_ROLES)[number];

export const envSchema = z.object({
  NODE_ENV: z.preprocess(blankAsUndefined, z.enum(['development', 'test', 'production']).default('production')),
  PORT: z.preprocess(blankAsUndefined, z.coerce.number().int().min(1).max(65535).default(3000)),

  MONGO_URI: str().refine((v) => /^mongodb(\+srv)?:\/\//.test(v), {
    message: 'must start with mongodb:// or mongodb+srv://',
  }),
  RAW_DB_NAME: str().default('provider_raw'),
  TARGET_DB_NAME: str().default('provider_domain'),

  REDIS_URL: str().refine((v) => /^rediss?:\/\//.test(v), {
    message: 'must start with redis:// or rediss://',
  }),

  APP_ROLE: z.preprocess(blankAsUndefined, z.enum(APP_ROLES).default('all')),
  WORKER_CONCURRENCY: posInt().default(4),
  JOB_ATTEMPTS: posInt().default(5),
  JOB_BACKOFF_MS: z.preprocess(blankAsUndefined, z.coerce.number().int().min(0).default(1000)),

  BATCH_SIZE_DEFAULT: posInt().default(200),
  // Menu documents are ~27 KB each, so they get a much smaller batch.
  BATCH_SIZE_MENUS: posInt().default(25),
  ERROR_SAMPLE_SIZE: z.preprocess(blankAsUndefined, z.coerce.number().int().min(0).default(20)),

  LOG_LEVEL: z.preprocess(
    blankAsUndefined,
    z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  ),
});

export type Env = z.infer<typeof envSchema>;

export class EnvValidationError extends Error {
  constructor(readonly fieldErrors: Record<string, string[] | undefined>) {
    const summary = Object.entries(fieldErrors)
      .map(([key, errs]) => `${key}: ${(errs ?? []).join('; ')}`)
      .join(', ');
    super(`Invalid environment configuration: ${summary}`);
    this.name = 'EnvValidationError';
  }
}

/** Pure parse. Throws EnvValidationError with flattened issues on failure. */
export function parseEnv(raw: Record<string, unknown>): Env {
  const result = envSchema.safeParse(raw);
  if (!result.success) {
    throw new EnvValidationError(z.flattenError(result.error).fieldErrors);
  }
  return result.data;
}

/**
 * Process boundary: parse, or print the flattened issues and exit(1).
 * Runs before Nest instantiates any provider, so no connection is ever attempted
 * with a bad config. Output is a single JSON line, matching the runtime log format.
 */
export function validateEnvOrExit(raw: Record<string, unknown>): Env {
  try {
    return parseEnv(raw);
  } catch (err) {
    if (!(err instanceof EnvValidationError)) throw err;
    process.stderr.write(
      JSON.stringify({
        level: 'fatal',
        time: new Date().toISOString(),
        msg: err.message,
        fieldErrors: err.fieldErrors,
      }) + '\n',
    );
    process.exit(1);
  }
}
