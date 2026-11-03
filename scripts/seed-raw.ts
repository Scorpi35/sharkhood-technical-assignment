/**
 * ts-node entry point for `npm run seed` (local dev). The implementation lives in
 * src/infra/seed so it is compiled into dist/ and runnable in the Docker image too.
 */
import { main } from '../src/infra/seed/seed-raw';

main().catch((err: unknown) => {
  const e = err instanceof Error ? err : new Error(String(err));
  process.stderr.write(
    JSON.stringify({ level: 'fatal', time: new Date().toISOString(), msg: 'Seed failed', err: { message: e.message, stack: e.stack } }) +
      '\n',
  );
  process.exit(1);
});
