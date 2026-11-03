import { Inject, Injectable } from '@nestjs/common';
import { Collection, Db } from 'mongodb';
import {
  Batch,
  BATCH_STATUSES,
  BatchRepository,
  BatchStatus,
  BatchStatusCounts,
  COUNTER_NAMES,
  RunCounters,
  SETTLED_BATCH_STATUSES,
  zeroCounters,
} from '../../core';
import { TARGET_DB } from '../../infra/mongo/mongo.tokens';
import { bulkUpsert } from '../shared/versioned-upsert';
import { RUN_BATCHES } from './run-metadata.indexes';

type BatchDoc = Batch & { createdAt: Date; updatedAt: Date };
const UNSETTLED = { $nin: [...SETTLED_BATCH_STATUSES] };

@Injectable()
export class MongoBatchRepository implements BatchRepository {
  private readonly collection: Collection<BatchDoc>;

  constructor(@Inject(TARGET_DB) db: Db) {
    this.collection = db.collection<BatchDoc>(RUN_BATCHES);
  }

  async createMany(batches: readonly Omit<Batch, 'status' | 'attempts'>[], at: Date): Promise<number> {
    const out = await bulkUpsert(
      this.collection as unknown as Collection,
      batches.map((b) => ({
        filter: { runId: b.runId, batchKey: b.batchKey },
        update: { $setOnInsert: { rawCollection: b.rawCollection, fromId: b.fromId, toId: b.toId, status: 'queued', attempts: 0, createdAt: at, updatedAt: at } },
      })),
    );
    return out.written; // $setOnInsert on an existing row is "unchanged": only new rows count
  }

  async markActive(runId: string, batchKey: string, at: Date): Promise<number | null> {
    const doc = await this.collection.findOneAndUpdate(
      { runId, batchKey, status: UNSETTLED },
      { $set: { status: 'active', updatedAt: at }, $inc: { attempts: 1 } },
      { returnDocument: 'after' },
    );
    return doc ? doc.attempts : null;
  }

  async recordFailure(runId: string, batchKey: string, error: string, at: Date): Promise<void> {
    await this.collection.updateOne({ runId, batchKey, status: 'active' }, { $set: { status: 'queued', lastError: error, updatedAt: at } });
  }

  /** The exactly-once gate: only the call that moves an unsettled batch to completed gets `true`. */
  async complete(runId: string, batchKey: string, counters: RunCounters, at: Date): Promise<boolean> {
    const doc = await this.collection.findOneAndUpdate(
      { runId, batchKey, status: UNSETTLED },
      { $set: { status: 'completed', counters, updatedAt: at } },
    );
    return doc !== null;
  }

  async markDead(runId: string, batchKey: string, error: string, at: Date): Promise<boolean> {
    const doc = await this.collection.findOneAndUpdate(
      { runId, batchKey, status: UNSETTLED },
      { $set: { status: 'dead', lastError: error, updatedAt: at } },
    );
    return doc !== null;
  }

  async get(runId: string, batchKey: string): Promise<Batch | null> {
    return this.collection.findOne({ runId, batchKey }, { projection: { _id: 0, createdAt: 0, updatedAt: 0 } });
  }

  async countByStatus(runId: string): Promise<BatchStatusCounts> {
    const rows = await this.collection
      .aggregate<{ _id: { rawCollection: string; status: BatchStatus }; n: number }>([
        { $match: { runId } },
        { $group: { _id: { rawCollection: '$rawCollection', status: '$status' }, n: { $sum: 1 } } },
      ])
      .toArray();
    const out: BatchStatusCounts = {};
    for (const { _id, n } of rows) {
      out[_id.rawCollection] ??= Object.fromEntries(BATCH_STATUSES.map((s) => [s, 0])) as Record<BatchStatus, number>;
      out[_id.rawCollection][_id.status] = n;
    }
    return out;
  }

  async sumCompletedCounters(runId: string): Promise<RunCounters> {
    const [row] = await this.collection
      .aggregate<RunCounters>([
        { $match: { runId, status: 'completed' } },
        { $group: { _id: null, ...Object.fromEntries(COUNTER_NAMES.map((n) => [n, { $sum: { $ifNull: [`$counters.${n}`, 0] } }])) } },
        { $project: { _id: 0 } },
      ])
      .toArray();
    return { ...zeroCounters(), ...(row ?? {}) };
  }

  async listByStatus(runId: string, status: BatchStatus, page: { readonly afterKey?: string; readonly limit: number }): Promise<Batch[]> {
    return this.collection
      .find(
        { runId, status, ...(page.afterKey === undefined ? {} : { batchKey: { $gt: page.afterKey } }) },
        { projection: { _id: 0, createdAt: 0, updatedAt: 0 } },
      )
      .sort({ batchKey: 1 })
      .limit(page.limit)
      .toArray();
  }
}
