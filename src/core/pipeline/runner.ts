import type { ProviderAdapter, SourceHandler } from '../providers/provider-adapter';
import { ProviderRegistry } from '../providers/provider-registry';
import { dedupe, recordGroupKey } from './dedupe';
import { stableStringify } from './stable-stringify';
import type { Stage, StageContext } from './stage';
import {
  DomainRecord,
  DomainRecordDraft,
  ENTITY_KINDS,
  EntityKind,
  Issue,
  QUARANTINE_REASONS,
  QuarantineReason,
  RawDocument,
} from './types';

/** An Issue tied to the raw document (and stage) that produced it. */
export interface PipelineIssue extends Issue {
  readonly sourceId: string;
  readonly rawCollection: string;
  readonly stage: string;
}

export interface PipelineCounters {
  readonly rawDocuments: number;
  /** Documents whose records were all accepted. */
  readonly okDocuments: number;
  /** Documents rejected as a whole (one or more issues). */
  readonly quarantinedDocuments: number;
  /** Accepted documents that produced no records at all. */
  readonly documentsWithoutRecords: number;
  /** Records emitted by accepted documents, before cross-batch dedupe. */
  readonly recordsEmitted: number;
  /** Records dropped because a newer (or identical) record had the same key. */
  readonly deduplicated: number;
  readonly records: number;
  readonly recordsByEntity: Readonly<Record<EntityKind, number>>;
  readonly issuesByReason: Readonly<Record<QuarantineReason, number>>;
}

export interface PipelineResult {
  readonly records: DomainRecord[];
  readonly issues: PipelineIssue[];
  readonly counters: PipelineCounters;
}

type DocOutcome = { ok: true; records: DomainRecord[]; collapsed: number } | { ok: false; issues: PipelineIssue[] };

/** The per-document stages, built from a SourceHandler. */
export function buildStages(handler: SourceHandler): readonly Stage<unknown, unknown>[] {
  return [
    { name: 'validate', run: (raw) => [handler.validate((raw as RawDocument).body)] },
    { name: 'normalise', run: (valid) => [{ ok: true, value: handler.normalise(valid) }] },
    { name: 'map', run: (normalised, ctx) => handler.map(normalised, ctx.mapping) },
  ];
}

/**
 * Pure batch pipeline: validate -> normalise -> map per raw document, then
 * deduplicate across the batch, then project into a deterministic order.
 *
 * - All-or-nothing per document: if any outcome of a document fails, none of its
 *   records are kept and all its issues are reported. Partial documents would
 *   leave dangling references (e.g. a menu listing an item that was dropped).
 * - An exception thrown anywhere while processing one document becomes a
 *   TRANSFORM_ERROR for that document only; the rest of the batch continues.
 * - A raw collection with no handler is a wiring bug, not bad data: it throws.
 */
export function runPipeline(raw: readonly RawDocument[], adapter: ProviderAdapter): PipelineResult {
  const registry = new ProviderRegistry([adapter]);
  const stagesByCollection = new Map<string, readonly Stage<unknown, unknown>[]>();

  const accepted: DomainRecord[] = [];
  const issues: PipelineIssue[] = [];
  let okDocuments = 0;
  let documentsWithoutRecords = 0;
  let collapsedWithinDocs = 0;

  for (const doc of raw) {
    const { handler } = registry.resolve(doc.collection);
    let stages = stagesByCollection.get(doc.collection);
    if (!stages) stagesByCollection.set(doc.collection, (stages = buildStages(handler)));
    const ctx: StageContext = {
      provider: adapter.provider,
      platform: adapter.platform,
      rawCollection: doc.collection,
      mapping: handler.mapping ?? [],
    };

    const outcome = processDocument(doc, stages, ctx);
    if (outcome.ok) {
      okDocuments += 1;
      collapsedWithinDocs += outcome.collapsed;
      if (outcome.records.length === 0) documentsWithoutRecords += 1;
      accepted.push(...outcome.records);
    } else {
      issues.push(...outcome.issues);
    }
  }

  const { winners, deduplicated } = dedupe(accepted);
  const records = project(winners);
  const sortedIssues = [...issues].sort(compareIssues);

  return {
    records,
    issues: sortedIssues,
    counters: {
      rawDocuments: raw.length,
      okDocuments,
      quarantinedDocuments: raw.length - okDocuments,
      documentsWithoutRecords,
      recordsEmitted: accepted.length + collapsedWithinDocs,
      deduplicated: deduplicated + collapsedWithinDocs,
      records: records.length,
      recordsByEntity: tally(ENTITY_KINDS, records.map((r) => r.entity)),
      issuesByReason: tally(QUARANTINE_REASONS, sortedIssues.map((i) => i.reason)),
    },
  };
}

function processDocument(doc: RawDocument, stages: readonly Stage<unknown, unknown>[], ctx: StageContext): DocOutcome {
  const issue = (stage: string, i: Issue): PipelineIssue => ({ ...i, sourceId: doc.id, rawCollection: doc.collection, stage });
  let stage = 'input';
  try {
    if (!(doc.sourceTs instanceof Date) || Number.isNaN(doc.sourceTs.getTime())) {
      return { ok: false, issues: [issue(stage, { reason: 'SCHEMA_INVALID', message: 'sourceTs is not a valid Date' })] };
    }

    let values: unknown[] = [doc];
    for (const s of stages) {
      stage = s.name;
      const next: unknown[] = [];
      const failures: PipelineIssue[] = [];
      for (const input of values) {
        for (const outcome of s.run(input, ctx)) {
          if (outcome.ok) next.push(outcome.value);
          else failures.push(issue(stage, outcome.issue));
        }
      }
      if (failures.length > 0) return { ok: false, issues: failures };
      values = next;
    }

    stage = 'stamp';
    const records = (values as DomainRecordDraft[]).map((draft) => stamp(draft, doc, ctx));

    // Within one document, a repeated key must carry identical data. Differing data
    // means the handler cannot decide which is right: that is a conflict, not a dedupe.
    stage = 'dedupe';
    const byKey = new Map<string, DomainRecord>();
    let collapsed = 0;
    for (const r of records) {
      const k = recordGroupKey(r);
      const prev = byKey.get(k);
      if (!prev) {
        byKey.set(k, r);
      } else if (stableStringify(prev.data) === stableStringify(r.data)) {
        collapsed += 1;
      } else {
        return {
          ok: false,
          issues: [
            issue(stage, {
              reason: 'DUPLICATE_CONFLICT',
              message: `document emits ${r.entity} ${stableStringify(r.key)} twice with different data`,
              details: { entity: r.entity, key: r.key },
            }),
          ],
        };
      }
    }
    return { ok: true, records: [...byKey.values()], collapsed };
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err));
    return {
      ok: false,
      issues: [issue(stage, { reason: 'TRANSFORM_ERROR', message: e.message, details: { error: e.name } })],
    };
  }
}

function stamp(draft: DomainRecordDraft, doc: RawDocument, ctx: StageContext): DomainRecord {
  if (!draft || !(ENTITY_KINDS as readonly string[]).includes(draft.entity)) {
    throw new TypeError(`map() emitted an unknown entity: ${JSON.stringify(draft?.entity)}`);
  }
  return {
    ...draft,
    version: { sourceTs: doc.sourceTs, rawId: doc.id },
    source: { provider: ctx.provider, rawCollection: doc.collection },
  } as DomainRecord;
}

/** Projection: a stable output order (entity, then key), independent of input order. */
function project(records: DomainRecord[]): DomainRecord[] {
  const rank = (e: EntityKind) => ENTITY_KINDS.indexOf(e);
  return records
    .map((r) => ({ r, k: recordGroupKey(r) }))
    .sort((a, b) => rank(a.r.entity) - rank(b.r.entity) || (a.k < b.k ? -1 : a.k > b.k ? 1 : 0))
    .map(({ r }) => r);
}

function compareIssues(a: PipelineIssue, b: PipelineIssue): number {
  const ka = `${a.sourceId}|${a.stage}|${a.path ?? ''}|${a.reason}|${a.message}`;
  const kb = `${b.sourceId}|${b.stage}|${b.path ?? ''}|${b.reason}|${b.message}`;
  return ka < kb ? -1 : ka > kb ? 1 : 0;
}

function tally<K extends string>(keys: readonly K[], values: readonly K[]): Record<K, number> {
  const out = Object.fromEntries(keys.map((k) => [k, 0])) as Record<K, number>;
  for (const v of values) out[v] += 1;
  return out;
}
