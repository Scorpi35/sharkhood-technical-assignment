import { EnvValidationError, parseEnv } from './env.schema';

const base = { MONGO_URI: 'mongodb://localhost:27017', REDIS_URL: 'redis://localhost:6379' };

function fieldErrorsOf(raw: Record<string, unknown>): Record<string, string[] | undefined> {
  try {
    parseEnv(raw);
  } catch (err) {
    if (err instanceof EnvValidationError) return err.fieldErrors;
    throw err;
  }
  throw new Error('expected parseEnv to throw');
}

describe('envSchema', () => {
  it('applies documented defaults', () => {
    const env = parseEnv(base);
    expect(env).toMatchObject({
      NODE_ENV: 'production',
      PORT: 3000,
      RAW_DB_NAME: 'provider_raw',
      TARGET_DB_NAME: 'provider_domain',
      APP_ROLE: 'all',
      JOB_ATTEMPTS: 5,
      JOB_BACKOFF_MS: 1000,
      BATCH_SIZE_DEFAULT: 200,
      BATCH_SIZE_MENUS: 25,
      ERROR_SAMPLE_SIZE: 20,
      LOG_LEVEL: 'info',
    });
  });

  it('coerces numeric strings', () => {
    expect(parseEnv({ ...base, WORKER_CONCURRENCY: '8', PORT: '8080' })).toMatchObject({
      WORKER_CONCURRENCY: 8,
      PORT: 8080,
    });
  });

  it('rejects a missing MONGO_URI', () => {
    expect(fieldErrorsOf({ REDIS_URL: base.REDIS_URL }).MONGO_URI).toBeDefined();
  });

  it('treats an empty MONGO_URI as missing', () => {
    expect(fieldErrorsOf({ ...base, MONGO_URI: '' }).MONGO_URI).toBeDefined();
  });

  it.each(['abc', '0', '1.5', '-2'])('rejects WORKER_CONCURRENCY=%s', (value) => {
    expect(fieldErrorsOf({ ...base, WORKER_CONCURRENCY: value }).WORKER_CONCURRENCY).toBeDefined();
  });

  it('rejects an unknown APP_ROLE', () => {
    expect(fieldErrorsOf({ ...base, APP_ROLE: 'scheduler' }).APP_ROLE).toBeDefined();
  });

  it('reports every invalid field at once', () => {
    const errors = fieldErrorsOf({ WORKER_CONCURRENCY: 'abc' });
    expect(Object.keys(errors).sort()).toEqual(['MONGO_URI', 'REDIS_URL', 'WORKER_CONCURRENCY']);
  });
});
