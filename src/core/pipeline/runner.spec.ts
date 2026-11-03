import { applyMapping, FieldMapping } from '../transform/mapping-interpreter';
import type { ProviderAdapter, SourceHandler } from '../providers/provider-adapter';
import { ProviderRegistryError } from '../providers/provider-registry';
import { runPipeline } from './runner';
import { raw, seededRandom, shuffle } from './test-helpers';
import { AreaData, DomainRecordDraft, fail, ok, StageOutcome, warning } from './types';

/** A tiny fake provider: each raw doc lists areas; map() fans out one record per area. */
interface ThingBody {
  areas: { id: number; name: string; slug: string }[];
}

const mapping: FieldMapping[] = [
  { target: 'area.name', from: 'name', transforms: ['trimCollapse'] },
  { target: 'area.slug', from: 'slug' },
];

function handler(overrides: Partial<SourceHandler<ThingBody, ThingBody>> = {}): SourceHandler<ThingBody, ThingBody> {
  return {
    rawCollection: 'raw_things',
    mapping,
    validate(body): StageOutcome<ThingBody> {
      const b = body as Partial<ThingBody> & { error?: string };
      if (b.error !== undefined) return fail({ reason: 'PROVIDER_ERROR', message: 'provider error payload' });
      if (!Array.isArray(b.areas)) return fail({ reason: 'SCHEMA_INVALID', message: 'areas must be an array', path: 'areas' });
      return ok(b as ThingBody);
    },
    normalise: (valid) => valid,
    map(n, m): StageOutcome<DomainRecordDraft>[] {
      return n.areas.map((a) => {
        if (a.name === 'boom') throw new Error('unexpected bug in map');
        if (a.name === 'bad') return fail({ reason: 'SCHEMA_INVALID', message: 'bad area', path: 'areas.name' });
        const mapped = applyMapping(a, m);
        return mapped.ok
          ? ok({ entity: 'area', key: { platform: 'example', externalId: String(a.id) }, data: mapped.value.area as AreaData }, a.name === 'Warned' ? [warning({ reason: 'DUPLICATE_CONFLICT', message: 'repaired', path: 'areas' })] : [])
          : mapped;
      });
    },
    ...overrides,
  };
}

const adapter = (h: SourceHandler<ThingBody, ThingBody> = handler()): ProviderAdapter => ({
  provider: 'fake',
  platform: 'example',
  sources: [h],
});

const area = (id: number, name = `Area ${id}`) => ({ id, name, slug: `area-${id}` });

describe('runPipeline', () => {
  it('turns a throwing handler into a TRANSFORM_ERROR and still processes the other docs', () => {
    const result = runPipeline(
      [raw('d1', { areas: [area(1)] }), raw('d2', { areas: [area(2, 'boom')] }), raw('d3', { areas: [area(3)] })],
      adapter(),
    );

    expect(result.issues).toEqual([
      expect.objectContaining({ sourceId: 'd2', rawCollection: 'raw_things', stage: 'map', reason: 'TRANSFORM_ERROR', message: 'unexpected bug in map' }),
    ]);
    expect(result.records.map((r) => r.key)).toEqual([
      { platform: 'example', externalId: '1' },
      { platform: 'example', externalId: '3' },
    ]);
    expect(result.counters).toMatchObject({ rawDocuments: 3, okDocuments: 2, quarantinedDocuments: 1 });
    expect(result.counters.issuesByReason.TRANSFORM_ERROR).toBe(1);
  });

  it('catches throws from validate and normalise too', () => {
    const throwsInValidate = handler({ validate: () => { throw new Error('validate blew up'); } });
    const throwsInNormalise = handler({ normalise: () => { throw new TypeError('normalise blew up'); } });
    expect(runPipeline([raw('d1', { areas: [] })], adapter(throwsInValidate)).issues[0]).toMatchObject({ stage: 'validate', reason: 'TRANSFORM_ERROR' });
    expect(runPipeline([raw('d1', { areas: [] })], adapter(throwsInNormalise)).issues[0]).toMatchObject({
      stage: 'normalise',
      reason: 'TRANSFORM_ERROR',
      details: { error: 'TypeError' },
    });
  });

  it('reports validation failures with the handler reason and path', () => {
    const { issues, records } = runPipeline([raw('e1', { error: '' }), raw('e2', { nope: true })], adapter());
    expect(records).toEqual([]);
    expect(issues).toEqual([
      expect.objectContaining({ sourceId: 'e1', stage: 'validate', reason: 'PROVIDER_ERROR' }),
      expect.objectContaining({ sourceId: 'e2', stage: 'validate', reason: 'SCHEMA_INVALID', path: 'areas' }),
    ]);
  });

  it('drops only the failed record when map() fails, keeping the rest of the document', () => {
    const { records, issues, counters } = runPipeline([raw('d1', { areas: [area(1), area(2, 'bad'), area(3)] })], adapter());
    expect(records.map((r) => r.key)).toEqual([
      { platform: 'example', externalId: '1' },
      { platform: 'example', externalId: '3' },
    ]);
    expect(issues).toEqual([expect.objectContaining({ stage: 'map', reason: 'SCHEMA_INVALID', severity: 'error', path: 'areas.name' })]);
    expect(counters).toMatchObject({ okDocuments: 0, partialDocuments: 1, quarantinedDocuments: 0, errors: 1 });
  });

  it('counts a document whose every record failed as quarantined', () => {
    const { records, counters } = runPipeline([raw('d1', { areas: [area(2, 'bad')] })], adapter());
    expect(records).toEqual([]);
    expect(counters).toMatchObject({ okDocuments: 0, partialDocuments: 0, quarantinedDocuments: 1 });
  });

  it('reports warnings without dropping the record', () => {
    const { records, issues, counters } = runPipeline([raw('d1', { areas: [area(1, 'Warned')] })], adapter());
    expect(records).toHaveLength(1);
    expect(issues).toEqual([expect.objectContaining({ reason: 'DUPLICATE_CONFLICT', severity: 'warning', stage: 'map' })]);
    expect(counters).toMatchObject({ okDocuments: 1, errors: 0, warnings: 1 });
  });

  it('stamps version and source from the raw document, and applies the mapping', () => {
    const ts = new Date('2026-09-14T04:59:25.739Z');
    const [record] = runPipeline([raw('abc', { areas: [area(7, '  Al   Zaab ')] }, 'raw_things', ts)], adapter()).records;
    expect(record).toEqual({
      entity: 'area',
      key: { platform: 'example', externalId: '7' },
      data: { name: 'Al Zaab', slug: 'area-7' },
      version: { sourceTs: ts, rawId: 'abc' },
      source: { provider: 'fake', rawCollection: 'raw_things' },
    });
  });

  it('dedupes across the batch: the newest document wins', () => {
    const { records, counters } = runPipeline(
      [
        raw('old', { areas: [area(1, 'Old name')] }, 'raw_things', new Date('2026-01-01')),
        raw('new', { areas: [area(1, 'New name')] }, 'raw_things', new Date('2026-02-01')),
      ],
      adapter(),
    );
    expect(records).toHaveLength(1);
    expect(records[0].data).toMatchObject({ name: 'New name' });
    expect(counters).toMatchObject({ recordsEmitted: 2, deduplicated: 1, records: 1 });
  });

  it('collapses an identical repeat within a document, but quarantines a conflicting one', () => {
    const same = runPipeline([raw('d1', { areas: [area(1), area(1)] })], adapter());
    expect(same.records).toHaveLength(1);
    expect(same.counters.deduplicated).toBe(1);

    const conflict = runPipeline([raw('d1', { areas: [area(1, 'A'), area(1, 'B')] })], adapter());
    expect(conflict.records).toEqual([]);
    expect(conflict.issues[0]).toMatchObject({ reason: 'DUPLICATE_CONFLICT', stage: 'dedupe' });
  });

  it('rejects a document whose sourceTs is not a valid date', () => {
    const { issues } = runPipeline([raw('d1', { areas: [] }, 'raw_things', new Date('nope'))], adapter());
    expect(issues[0]).toMatchObject({ reason: 'SCHEMA_INVALID', stage: 'input' });
  });

  it('quarantines a handler that emits an unknown entity', () => {
    const bogus = handler({ map: () => [ok({ entity: 'pizza' } as unknown as DomainRecordDraft)] });
    expect(runPipeline([raw('d1', { areas: [] })], adapter(bogus)).issues[0]).toMatchObject({ reason: 'TRANSFORM_ERROR', stage: 'stamp' });
  });

  it('counts accepted documents that produce no records', () => {
    expect(runPipeline([raw('d1', { areas: [] })], adapter()).counters).toMatchObject({ okDocuments: 1, documentsWithoutRecords: 1 });
  });

  it('throws for a raw collection with no handler (wiring bug, not bad data)', () => {
    expect(() => runPipeline([raw('d1', {}, 'raw_unknown')], adapter())).toThrow(ProviderRegistryError);
  });

  it('produces identical output for any input order', () => {
    const docs = [
      raw('d1', { areas: [area(3), area(1)] }, 'raw_things', new Date('2026-01-01')),
      raw('d2', { areas: [area(1, 'Newer')] }, 'raw_things', new Date('2026-02-01')),
      raw('d3', { areas: [area(2, 'boom')] }),
      raw('d4', { error: 'x' }),
      raw('d5', { areas: [area(4)] }),
    ];
    const expected = runPipeline(docs, adapter());
    const rand = seededRandom(7);
    for (let i = 0; i < 10; i++) {
      expect(runPipeline(shuffle(docs, rand), adapter())).toEqual(expected);
    }
  });
});
