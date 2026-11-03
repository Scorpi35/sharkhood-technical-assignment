/** ts-node entry for `npm run migrate`; the logic lives in src/cli so it compiles into dist/ for the image. */
import { main } from '../src/cli/migrate';

main().catch((err: unknown) => {
  process.stderr.write(`${(err as Error).stack ?? String(err)}\n`);
  process.exit(1);
});
