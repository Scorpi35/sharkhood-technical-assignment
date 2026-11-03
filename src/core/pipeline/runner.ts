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
  IssueSeverity,
  QUARANTINE_REASONS,
  QuarantineReason,
  RawDocument,
} from './types';

/** An Issue tied to the raw document (and stage) that produced it. Severity is always set. */
export interface PipelineIssue extends Issue {
  readonly sourceId: string;
  readonly rawCollection: string;
  readonly stage: string;
  readonly severity: IssueSeverity;
}

export interface PipelineCounters {
  readonly rawDocuments: number;
  /** Documents with no error issues (warnings allowed). */
  readonly okDocuments: number;
  /** Documents that produced records but also lost some to record-level errors. */
  readonly partialDocuments: number;
  /** Documents that produced no records because of errors. */
  readonly quarantinedDocuments: number;
  /** Error-free documents that produced no records at all. */
  readonly documentsWithoutRecords: number;
  /** Records emitted by documents, before dedupe. */
  readonly recordsEmitted: number;
  /** Records dropped because a newer (or identical) record had the same key. */
  readonly deduplicated: number;
  readonly records: number;
  readonly errors: number;
  readonly warnings: number;
  readonly recordsByEntity: Readonly<Record<EntityKind, number>>;
  readonly issuesByReason: Readonly<Record<QuarantineReason, number>>;
}

export interface PipelineResult {
  readonly records: DomainRecord[];
  /** Errors and warnings, deterministically ordered. Filter on `severity` as needed. */
  readonly issues: PipelineIssue[];
  readonly counters: PipelineCounters;
}

interface DocResult {
  readonly records: DomainRecord[];
  readonly issues: PipelineIssue[];
  readonly collapsed: number;
}

/** Stages whose failure rejects the whole document. After these, failures are per record. */
const DOCUMENT_LEVEL_STAGES = new Set(['validate', 'normalise']);

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
 * Failure granularity:
 * - validate / normalise failure: the whole document is rejected (nothing usable).
 * - map failure: only that record is dropped; the document's other records are
 *   kept. A handler that needs all-or-nothing (e.g. to avoid dangling references)
 *   expresses it by emitting only the failure.
 * - warnings on successful outcomes are reported but never drop anything.
 * - An exception thrown while processing a document is a bug: TRANSFORM_ERROR for
 *   that document only; the rest of the batch continues.
 * - A raw collection with no handler is a wiring bug, not bad data: it throws.
 */
export function runPipeline(raw: readonly RawDocument[], adapter: ProviderAdapter): PipelineResult {
  const registry = new ProviderRegistry([adapter]);
  const stagesByCollection = new Map<string, readonly Stage<unknown, unknown>[]>();

  const emitted: DomainRecord[] = [];
  const issues: PipelineIssue[] = [];
  let okDocuments = 0;
  let partialDocuments = 0;
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

    const result = processDocument(doc, stages, ctx);
    const hasErrors = result.issues.some((i) => i.severity === 'error');
    if (!hasErrors) {
      okDocuments += 1;
      if (result.records.length === 0) documentsWithoutRecords += 1;
    } else if (result.records.length > 0) {
      partialDocuments += 1;
    }
    collapsedWithinDocs += result.collapsed;
    emitted.push(...result.records);
    issues.push(...result.issues);
  }

  const { winners, deduplicated } = dedupe(emitted);
  const records = project(winners);
  const sortedIssues = [...issues].sort(compareIssues);
  const errors = sortedIssues.filter((i) => i.severity === 'error').length;

  return {
    records,
    issues: sortedIssues,
    counters: {
      rawDocuments: raw.length,
      okDocuments,
      partialDocuments,
      quarantinedDocuments: raw.length - okDocuments - partialDocuments,
      documentsWithoutRecords,
      recordsEmitted: emitted.length + collapsedWithinDocs,
      deduplicated: deduplicated + collapsedWithinDocs,
      records: records.length,
      errors,
      warnings: sortedIssues.length - errors,
      recordsByEntity: tally(ENTITY_KINDS, records.map((r) => r.entity)),
      issuesByReason: tally(QUARANTINE_REASONS, sortedIssues.map((i) => i.reason)),
    },
  };
}

function processDocument(doc: RawDocument, stages: readonly Stage<unknown, unknown>[], ctx: StageContext): DocResult {
  const issue = (stage: string, i: Issue): PipelineIssue => ({
    ...i,
    severity: i.severity ?? 'error',
    sourceId: doc.id,
    rawCollection: doc.collection,
    stage,
  });
  const rejected = (list: PipelineIssue[]): DocResult => ({ records: [], issues: list, collapsed: 0 });

  let stage = 'input';
  try {
    if (!(doc.sourceTs instanceof Date) || Number.isNaN(doc.sourceTs.getTime())) {
      return rejected([issue(stage, { reason: 'SCHEMA_INVALID', message: 'sourceTs is not a valid Date' })]);
    }

    const reported: PipelineIssue[] = [];
    let values: unknown[] = [doc];
    for (const s of stages) {
      stage = s.name;
      const next: unknown[] = [];
      const failures: PipelineIssue[] = [];
      for (const input of values) {
        for (const outcome of s.run(input, ctx)) {
          if (outcome.ok) {
            next.push(outcome.value);
            for (const w of outcome.warnings ?? []) reported.push(issue(stage, w));
          } else {
            failures.push(issue(stage, outcome.issue));
          }
        }
      }
      if (failures.length > 0 && DOCUMENT_LEVEL_STAGES.has(stage)) return rejected([...reported, ...failures]);
      reported.push(...failures);
      values = next;
    }

    stage = 'stamp';
    const records = (values as DomainRecordDraft[]).map((draft) => stamp(draft, doc, ctx));

    // Within one document, a repeated key must carry identical data. Differing data
    // means the handler cannot decide which is right: the document is rejected.
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
        return rejected([
          issue(stage, {
            reason: 'DUPLICATE_CONFLICT',
            message: `document emits ${r.entity} ${stableStringify(r.key)} twice with different data`,
            details: { entity: r.entity, key: r.key },
          }),
        ]);
      }
    }
    return { records: [...byKey.values()], issues: reported, collapsed };
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err));
    return rejected([issue(stage, { reason: 'TRANSFORM_ERROR', message: e.message, details: { error: e.name } })]);
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
  const ka = `${a.sourceId}|${a.stage}|${a.path ?? ''}|${a.reason}|${a.severity}|${a.message}`;
  const kb = `${b.sourceId}|${b.stage}|${b.path ?? ''}|${b.reason}|${b.severity}|${b.message}`;
  return ka < kb ? -1 : ka > kb ? 1 : 0;
}

function tally<K extends string>(keys: readonly K[], values: readonly K[]): Record<K, number> {
  const out = Object.fromEntries(keys.map((k) => [k, 0])) as Record<K, number>;
  for (const v of values) out[v] += 1;
  return out;
}
