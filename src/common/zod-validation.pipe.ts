import { BadRequestException, PipeTransform } from '@nestjs/common';
import { z } from 'zod';

export interface ValidationIssue {
  /** Dot path into the input ("collections.0"); "" for the root. */
  readonly path: string;
  readonly message: string;
}

/**
 * Validates (and coerces) a request part with a Zod schema. Failure is a 400
 * whose body lists every issue with its path, e.g. {path: "limit", message: "…"}.
 */
export class ZodValidationPipe<S extends z.ZodType> implements PipeTransform<unknown, z.infer<S>> {
  constructor(protected readonly schema: S) {}

  transform(value: unknown): z.infer<S> {
    const result = this.schema.safeParse(value ?? {});
    if (result.success) return result.data;
    const issues: ValidationIssue[] = result.error.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message }));
    throw new BadRequestException({ message: 'Request validation failed', issues });
  }
}
