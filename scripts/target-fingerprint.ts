/** ts-node entry for `npm run fingerprint`; the logic lives in src/domain so it compiles into dist/ for the image. */
import { main } from '../src/domain/fingerprint/target-fingerprint';

main().catch((err: unknown) => {
  process.stderr.write(`${String(err)}\n`);
  process.exit(1);
});
