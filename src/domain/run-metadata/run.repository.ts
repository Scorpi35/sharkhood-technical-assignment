import { Inject, Injectable } from '@nestjs/common';
import { Collection, Db } from 'mongodb';
import {
  Run,
  RunCounters,
  RunRepository,
  RunSourceProgress,
  RunStatus,
  RunTimings,
  SampledIssue,
  TERMINAL_RUN_STATUSES,
} from '../../core';
import { TARGET_DB } from '../../infra/mongo/mongo.tokens';
import { RUNS } from './run-metadata.indexes';

type RunDoc = Omit<Run, 'runId'> & { _id: string };

/** Raw collection names become field names under `sources`, so they must be plain identifiers. */
const SAFE = /^[A-Za-z0-9_-]+$/;
const sourcePath = (rawCollection: string): string => {
  if (!SAFE.test(rawCollection)) throw new TypeError(`unsafe raw collection name for a field path: "${rawCollection}"`);
  return `sources.${rawCollection}`;
};
const prefixed = (prefix: string, values: Readonly<Record<string, unknown>>) =>
  Object.fromEntries(Object.entries(values).filter(([, v]) => v !== undefined).map(([k, v]) => [`${prefix}.${k}`, v]));

@Injectable()
export class MongoRunRepository implements RunRepository {
  private readonly collection: Collection<RunDoc>;

  constructor(@Inject(TARGET_DB) db: Db) {
    this.collection = db.collection<RunDoc>(RUNS);
  }

  async create(run: Run): Promise<void> {
    const { runId, ...rest } = run;
    Object.keys(rest.sources).forEach(sourcePath);
    await this.collection.insertOne({ _id: runId, ...rest });
  }

  async get(runId: string): Promise<Run | null> {
    const doc = await this.collection.findOne({ _id: runId });
    if (!doc) return null;
    const { _id, ...rest } = doc;
    return { runId: _id, ...rest };
  }

  async listIdsByStatus(statuses: readonly RunStatus[], limit: number): Promise<string[]> {
    const docs = await this.collection
      .find({ status: { $in: [...statuses] } }, { projection: { _id: 1 } })
      .sort({ 'timings.createdAt': 1 })
      .limit(limit)
      .toArray();
    return docs.map((d) => d._id);
  }

  async transition(runId: string, from: readonly RunStatus[], to: RunStatus, timings: Partial<RunTimings> = {}, lastError?: string): Promise<boolean> {
    const r = await this.collection.updateOne(
      { _id: runId, status: { $in: [...from] } },
      { $set: { status: to, ...prefixed('timings', timings), ...(lastError === undefined ? {} : { lastError }) } },
    );
    return r.modifiedCount === 1;
  }

  async recordDispatch(
    runId: string,
    rawCollection: string,
    p: { cursor: string | null; batchesAdded: number; done: boolean; dispatchedDocs?: number },
  ): Promise<void> {
    const path = sourcePath(rawCollection);
    await this.collection.updateOne(
      { _id: runId },
      {
        $set: {
          [`${path}.dispatchCursor`]: p.cursor,
          [`${path}.dispatchDone`]: p.done,
          ...(p.dispatchedDocs === undefined ? {} : { [`${path}.dispatchedDocs`]: p.dispatchedDocs }),
        },
        $inc: { [`${path}.batchesTotal`]: p.batchesAdded },
      },
    );
  }

  async applyBatch(
    runId: string,
    rawCollection: string,
    outcome: 'completed' | 'dead',
    counters: Partial<RunCounters>,
    errors: readonly SampledIssue[],
    errorSampleSize: number,
    lastError?: string,
  ): Promise<void> {
    const path = sourcePath(rawCollection);
    const inc: Record<string, number> = { [`${path}.${outcome === 'completed' ? 'batchesDone' : 'batchesDead'}`]: 1 };
    for (const [name, n] of Object.entries(counters)) if (n) inc[`counters.${name}`] = n;
    await this.collection.updateOne(
      { _id: runId },
      {
        $inc: inc,
        $push: { errorSample: { $each: [...errors], $slice: -errorSampleSize } },
        ...(lastError === undefined ? {} : { $set: { lastError } }),
      },
    );
  }

  async finalise(
    runId: string,
    final: {
      status: RunStatus;
      counters: RunCounters;
      sources: Readonly<Record<string, RunSourceProgress>>;
      finishedAt: Date;
      durationMs: number;
      lastError?: string;
    },
  ): Promise<boolean> {
    const r = await this.collection.updateOne(
      { _id: runId, status: { $nin: [...TERMINAL_RUN_STATUSES] } },
      {
        $set: {
          status: final.status,
          counters: final.counters,
          sources: final.sources,
          'timings.finishedAt': final.finishedAt,
          'timings.durationMs': final.durationMs,
          ...(final.lastError === undefined ? {} : { lastError: final.lastError }),
        },
      },
    );
    return r.modifiedCount === 1;
  }
}
