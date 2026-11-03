import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { PROVIDER_REGISTRY, ProviderRegistry, QUARANTINE_REASONS } from '../core';
import { ZodValidationPipe } from '../common/zod-validation.pipe';

/** Upper bound on a per-run batch size: a batch is held in memory while it is processed. */
export const MAX_BATCH_SIZE = 5000;
export const DEFAULT_ERRORS_LIMIT = 50;
export const MAX_ERRORS_LIMIT = 200;

/**
 * POST /runs body. `collections` accepts the registered source aliases
 * (locations | restaurants | menus for xbyte), read from the ProviderRegistry so
 * the API itself carries no provider knowledge. Unknown keys are rejected.
 */
export const startRunBodySchema = (aliases: readonly [string, ...string[]]) =>
  z
    .object({
      collections: z.array(z.enum(aliases)).min(1).optional(),
      limit: z.number().int().positive().optional(),
      batchSize: z.number().int().positive().max(MAX_BATCH_SIZE).optional(),
    })
    .strict();
export type StartRunBody = z.infer<ReturnType<typeof startRunBodySchema>>;

@Injectable()
export class StartRunBodyPipe extends ZodValidationPipe<ReturnType<typeof startRunBodySchema>> {
  constructor(@Inject(PROVIDER_REGISTRY) registry: ProviderRegistry) {
    const aliases = registry.aliases();
    if (aliases.length === 0) throw new Error('no sources registered');
    super(startRunBodySchema(aliases as [string, ...string[]]));
  }
}

/** GET /runs/:id/errors query. `limit` defaults to 50 and is capped at 200. */
export const errorsQuerySchema = z.object({
  reason: z.enum(QUARANTINE_REASONS).optional(),
  cursor: z.string().min(1).optional(),
  limit: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_ERRORS_LIMIT)
    .transform((n) => Math.min(n, MAX_ERRORS_LIMIT)),
});
export type ErrorsQuery = z.infer<typeof errorsQuerySchema>;

@Injectable()
export class ErrorsQueryPipe extends ZodValidationPipe<typeof errorsQuerySchema> {
  constructor() {
    super(errorsQuerySchema);
  }
}
