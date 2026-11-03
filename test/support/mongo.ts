import * as os from 'node:os';
import { MongoClient, MongoClientOptions } from 'mongodb';

/**
 * Connect a MongoClient from inside Jest.
 *
 * Driver >= 7.6 loads `os` via dynamic `import()`, which fails inside Jest's VM
 * sandbox; the driver swallows that and sends empty handshake metadata, and the
 * server rejects it: "Missing required sub-document 'driver' in the client
 * metadata document" (upstream NODE-7832). Supplying the os adapter explicitly
 * avoids the dynamic import. Plain Node (the app, the seed script) is unaffected.
 * Remove once the driver ships the NODE-7832 fix.
 */
export function connectTestClient(uri: string, options: MongoClientOptions = {}): Promise<MongoClient> {
  return MongoClient.connect(uri, { runtimeAdapters: { os }, ...options });
}
