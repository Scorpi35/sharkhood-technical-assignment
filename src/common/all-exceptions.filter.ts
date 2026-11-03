import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import type { Response } from 'express';
import { InvalidCursorError } from '../core';
import { HealthCheckFailedError } from '../health/health.service';
import { InvalidRunFiltersError, RunAlreadyFinishedError, RunNotFoundError } from '../runs/runs.errors';

export interface ErrorBody {
  readonly statusCode: number;
  readonly error: string;
  readonly message: string;
  readonly runId?: string;
  readonly [extra: string]: unknown;
}

const reason = (status: number): string =>
  (HttpStatus[status] ?? 'Error')
    .toLowerCase()
    .split('_')
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ');

/**
 * Maps every error to JSON {statusCode, error, message, runId?}. Known errors get
 * their status; anything else is a 500 whose message is generic. Stack traces
 * are logged server-side and never sent.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    const { status, body } = this.toResponse(exception);
    if (status >= 500 && !(exception instanceof HealthCheckFailedError)) this.logger.error({ err: exception }, 'Unhandled error');
    res.status(status).json(body);
  }

  toResponse(exception: unknown): { status: number; body: ErrorBody | object } {
    const json = (status: number, message: string, extra: Record<string, unknown> = {}) => ({
      status,
      body: { statusCode: status, error: reason(status), message, ...extra },
    });

    if (exception instanceof HealthCheckFailedError) return { status: HttpStatus.SERVICE_UNAVAILABLE, body: exception.report };
    if (exception instanceof RunNotFoundError) return json(HttpStatus.NOT_FOUND, exception.message, { runId: exception.runId });
    if (exception instanceof RunAlreadyFinishedError) {
      return json(HttpStatus.CONFLICT, exception.message, { runId: exception.runId, status: exception.status });
    }
    if (exception instanceof InvalidRunFiltersError || exception instanceof InvalidCursorError) return json(HttpStatus.BAD_REQUEST, exception.message);
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const response = exception.getResponse();
      if (typeof response === 'string') return json(status, response);
      const { statusCode: _s, error: _e, message, ...extra } = response as Record<string, unknown>;
      return json(status, Array.isArray(message) ? message.join('; ') : String(message ?? exception.message), extra);
    }
    return json(HttpStatus.INTERNAL_SERVER_ERROR, 'Internal server error');
  }
}
