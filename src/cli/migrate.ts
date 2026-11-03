import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { loadConfigOrExit } from '../config/load-config';
import { TERMINAL_RUN_STATUSES } from '../core';
import { RunFilters, RunsService } from '../runs/runs.service';

/**
 * Start a run and (by default) wait for it to finish, then print a summary.
 *
 *   npm run migrate -- [--collections=a,b] [--limit=N] [--no-wait]
 *
 * In Docker (`docker compose run --rm api npm run migrate`) this process has the
 * api role, so it only enqueues; the worker container does the work.
 */
export async function main(argv = process.argv.slice(2)): Promise<void> {
  const arg = (name: string) => argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
  const filters: RunFilters = {
    ...(arg('collections') ? { collections: arg('collections')!.split(',').filter(Boolean) } : {}),
    ...(arg('limit') ? { limit: Number(arg('limit')) } : {}),
  };
  const wait = !argv.includes('--no-wait');

  const config = loadConfigOrExit();
  const app = await NestFactory.createApplicationContext(AppModule.forRole(config), { logger: ['error', 'warn'] });
  try {
    const runs = app.get(RunsService);
    let run = await runs.start(filters);
    process.stderr.write(`run ${run.runId} started (${Object.keys(run.sources).join(', ')})\n`);
    while (wait && !TERMINAL_RUN_STATUSES.includes(run.status)) {
      await new Promise((r) => setTimeout(r, 500));
      run = (await runs.getRun(run.runId))!;
    }
    const sources = Object.fromEntries(
      Object.entries(run.sources).map(([c, s]) => [c, { batchesTotal: s.batchesTotal, batchesDone: s.batchesDone, batchesDead: s.batchesDead }]),
    );
    process.stdout.write(
      JSON.stringify({ runId: run.runId, status: run.status, counters: run.counters, sources, durationMs: run.timings.durationMs }, null, 2) + '\n',
    );
  } finally {
    await app.close();
  }
}

if (require.main === module) {
  main().catch((err: unknown) => {
    process.stderr.write(`${(err as Error).stack ?? String(err)}\n`);
    process.exit(1);
  });
}
