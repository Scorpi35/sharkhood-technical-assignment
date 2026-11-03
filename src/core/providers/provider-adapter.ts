import type { DomainRecordDraft, StageOutcome } from '../pipeline/types';
import type { FieldMapping } from '../transform/mapping-interpreter';
import type { TransformRegistry } from '../transform/transform-registry';

export type { FieldMapping } from '../transform/mapping-interpreter';

/**
 * Everything the pipeline needs to process one raw collection. All three
 * functions must be pure and must return outcomes for bad data instead of
 * throwing; a throw is treated as a bug and quarantined as TRANSFORM_ERROR.
 *
 * Method syntax (not arrow properties) is deliberate: it keeps handlers with
 * concrete Valid/Normalised types assignable to SourceHandler<unknown, unknown>.
 */
export interface SourceHandler<Valid = unknown, Normalised = unknown> {
  readonly rawCollection: string;
  /** Raw docs per batch for this collection. Large documents want smaller batches. */
  readonly batchSize?: number;
  /** Declarative field mapping handed to map() through the stage context. */
  readonly mapping?: readonly FieldMapping[];
  /**
   * Transforms the mapping may name: built-ins plus the provider's bound ones.
   * Defaults to the built-ins. The mapping is checked against it when registered.
   */
  readonly transforms?: TransformRegistry;
  /** Structural check of the raw body; provider error payloads fail here. */
  validate(body: unknown): StageOutcome<Valid>;
  /** Clean values (types, whitespace, units). Cannot fail: validate() already did. */
  normalise(valid: Valid): Normalised;
  /** Emit domain record drafts; one document may fan out into many. */
  map(normalised: Normalised, mapping: readonly FieldMapping[]): readonly StageOutcome<DomainRecordDraft>[];
}

export interface ProviderAdapter {
  /** Provider name, e.g. the scraping vendor. Recorded in `source.provider`. */
  readonly provider: string;
  /** Platform the data describes. Entities are keyed on this, not on the provider. */
  readonly platform: string;
  readonly sources: readonly SourceHandler[];
}
