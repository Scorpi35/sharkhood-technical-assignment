import { AppConfig } from '../config/app-config';
import { parseEnv } from '../config/env.schema';
import { MongoPing, RedisPing } from './health.ports';
import { HealthCheckFailedError, HealthReport, HealthService } from './health.service';

const config = new AppConfig(parseEnv({ MONGO_URI: 'mongodb://x:27017', REDIS_URL: 'redis://x:6379', APP_ROLE: 'api' }));
const up = async () => undefined;
const hang = () => new Promise<void>(() => undefined);
const service = (mongo: Partial<MongoPing>, redis: RedisPing) => new HealthService({ raw: up, target: up, ...mongo }, redis, config);
const failure = async (s: HealthService): Promise<HealthReport> => {
  try {
    await s.check();
  } catch (e) {
    expect(e).toBeInstanceOf(HealthCheckFailedError);
    return (e as HealthCheckFailedError).report;
  }
  throw new Error('expected the health check to fail');
};

describe('HealthService', () => {
  it('reports every dependency up, with latencies', async () => {
    const report = await service({}, up).check();
    expect(report).toMatchObject({
      status: 'ok',
      role: 'api',
      mongo: { raw: { status: 'up', latencyMs: expect.any(Number) }, target: { status: 'up' } },
      redis: { status: 'up', latencyMs: expect.any(Number) },
    });
  });

  it('a failing dependency makes the whole check fail (503) and says which one', async () => {
    const report = await failure(service({ target: async () => Promise.reject(new Error('not primary')) }, up));
    expect(report).toMatchObject({ status: 'down', mongo: { raw: { status: 'up' }, target: { status: 'down', error: 'not primary' } }, redis: { status: 'up' } });
  });

  it('a dependency that never answers is down after the 1 s timeout', async () => {
    const started = Date.now();
    const report = await failure(service({}, hang));
    expect(report.redis).toMatchObject({ status: 'down', error: 'no answer within 1000 ms' });
    expect(Date.now() - started).toBeGreaterThanOrEqual(990);
    expect(Date.now() - started).toBeLessThan(2000); // the three checks run concurrently
  });
});
