import { AppConfig } from './app-config';
import { loadEnvFile } from './env-file';
import { validateEnvOrExit } from './env.schema';

/**
 * Load .env (if present, without overriding real env vars) and validate.
 * Called first thing in main.ts so the role is known before Nest boots, and
 * a bad config exits before any module (and so any connection) is created.
 */
export function loadConfigOrExit(envFile = '.env'): AppConfig {
  loadEnvFile(envFile);
  return new AppConfig(validateEnvOrExit(process.env));
}
