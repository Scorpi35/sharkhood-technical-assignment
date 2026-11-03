import type { Config } from 'jest';

/**
 * Integration tests: real Mongo (mongodb-memory-server) and Redis (testcontainers,
 * or REDIS_URL if set). Run in band: suites boot whole Nest apps with BullMQ workers.
 *   npm run test:int
 */
const config: Config = {
  rootDir: '.',
  roots: ['<rootDir>/integration'],
  testRegex: '.*\\.int-spec\\.ts$',
  moduleFileExtensions: ['js', 'json', 'ts'],
  transform: { '^.+\\.ts$': 'ts-jest' },
  testEnvironment: 'node',
  testTimeout: 120_000,
};

export default config;
