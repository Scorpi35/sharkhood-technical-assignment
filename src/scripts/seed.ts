import { loadConfigOrExit } from '../config/load-config';

/** Placeholder wired up in T01 so `npm run seed` exists; implemented in a later ticket. */
function main(): void {
  const config = loadConfigOrExit();
  process.stderr.write(
    JSON.stringify({
      level: 'error',
      time: new Date().toISOString(),
      msg: 'seed is not implemented yet',
      rawDb: config.mongo.rawDbName,
    }) + '\n',
  );
  process.exit(1);
}

main();
