import type { Db } from 'mongodb';
import type { MongoPing } from '../../health/health.ports';

/** `{ping: 1}` against each database; the health service bounds the wait. */
export const mongoPing = (raw: Db, target: Db): MongoPing => ({
  raw: async () => {
    await raw.command({ ping: 1 });
  },
  target: async () => {
    await target.command({ ping: 1 });
  },
});
