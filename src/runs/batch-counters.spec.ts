import { runPipeline, RawDocument } from '../core';
import { loadRawFixtures } from '../../test/support/fixtures';
import { RAW_COLLECTIONS } from '../providers/xbyte/mappings';
import { createXbyteAdapter } from '../providers/xbyte/xbyte.adapter';
import { batchCounters, quarantineEntries, sampledErrors } from './batch-counters';

describe('batch counters', () => {
  // Real fixture menus: 1 provider error page, 3 good menus (one with a merged-category warning).
  const docs: RawDocument[] = loadRawFixtures('xbyte/menus.json', RAW_COLLECTIONS.menus);
  const pipeline = runPipeline(docs, createXbyteAdapter());
  const write = { written: pipeline.records.length - 2, unchanged: 1, stale: 1 };

  it('maps pipeline and write results onto the run counter definitions', () => {
    expect(batchCounters(pipeline, write)).toEqual({
      read: 4,
      transformed: pipeline.records.length,
      written: write.written,
      unchanged: 1,
      stale: 1,
      deduplicated: pipeline.counters.deduplicated,
      skipped: 0,
      failed: 1, // the "not restaurant page" document
      warnings: 1, // Offers / Add On merged
    });
  });

  it('written + unchanged + stale = transformed', () => {
    const c = batchCounters(pipeline, write);
    expect(c.written + c.unchanged + c.stale).toBe(c.transformed);
  });

  it('EMPTY_PAYLOAD is skipped, not failed, and stays out of the error sample', () => {
    const empty: RawDocument = { ...docs[1], id: 'e'.repeat(24), body: { ...(docs[1].body as object), payload: { results: [] } } };
    const p = runPipeline([empty], createXbyteAdapter());
    expect(batchCounters(p, { written: 0, unchanged: 0, stale: 0 })).toMatchObject({ read: 1, skipped: 1, failed: 0 });
    expect(sampledErrors('k', p.issues)).toEqual([]);
    expect(quarantineEntries('run', 'k', 'job', p.issues)).toEqual([expect.objectContaining({ reason: 'EMPTY_PAYLOAD', severity: 'error' })]);
  });

  it('quarantines errors and warnings; samples only errors', () => {
    const entries = quarantineEntries('run-1', 'xbyte_raw_menus:a:z', 'job-7', pipeline.issues);
    expect(entries.map((e) => [e.reason, e.severity]).sort()).toEqual([
      ['DUPLICATE_CONFLICT', 'warning'],
      ['PROVIDER_ERROR', 'error'],
    ]);
    expect(entries.every((e) => e.runId === 'run-1' && e.jobId === 'job-7' && e.batchKey === 'xbyte_raw_menus:a:z')).toBe(true);
    expect(sampledErrors('xbyte_raw_menus:a:z', pipeline.issues).map((e) => e.reason)).toEqual(['PROVIDER_ERROR']);
  });
});
