/**
 * Side-effect module: load `.env` (if present) into process.env.
 *
 * Import it FIRST in every entry point that imports AppModule. AppConfigModule
 * validates process.env when its file is imported (ConfigModule.forRoot runs at
 * import time), so `.env` must be loaded before that import, not later in bootstrap.
 * Real environment variables always win (process.loadEnvFile never overrides them).
 */
export function loadEnvFile(envFile = '.env'): void {
  try {
    process.loadEnvFile(envFile);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

loadEnvFile();
