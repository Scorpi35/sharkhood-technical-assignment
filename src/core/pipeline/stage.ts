import type { FieldMapping } from '../transform/mapping-interpreter';
import type { StageOutcome } from './types';

/**
 * Static context for a stage. Deliberately holds no clock, no randomness and no
 * I/O handles: stages are pure, so the same input always yields the same output.
 */
export interface StageContext {
  readonly provider: string;
  readonly platform: string;
  readonly rawCollection: string;
  readonly mapping: readonly FieldMapping[];
}

/**
 * One pure step of the per-document pipeline. Returns a list because one input
 * can fan out into many outputs (one menu document -> restaurant, menu, items).
 */
export interface Stage<I, O> {
  readonly name: string;
  run(input: I, ctx: StageContext): readonly StageOutcome<O>[];
}
