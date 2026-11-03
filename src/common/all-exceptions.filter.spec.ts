import { BadRequestException, NotFoundException } from '@nestjs/common';
import { InvalidCursorError } from '../core';
import { HealthCheckFailedError, HealthReport } from '../health/health.service';
import { InvalidRunFiltersError, RunAlreadyFinishedError, RunNotFoundError } from '../runs/runs.errors';
import { AllExceptionsFilter } from './all-exceptions.filter';

const filter = new AllExceptionsFilter();
const map = (e: unknown) => filter.toResponse(e);

describe('AllExceptionsFilter', () => {
  it('maps known errors to {statusCode, error, message, runId?}', () => {
    expect(map(new RunNotFoundError('r1'))).toEqual({ status: 404, body: { statusCode: 404, error: 'Not Found', message: 'unknown run r1', runId: 'r1' } });
    expect(map(new RunAlreadyFinishedError('r1', 'completed'))).toEqual({
      status: 409,
      body: { statusCode: 409, error: 'Conflict', message: 'run r1 is already completed', runId: 'r1', status: 'completed' },
    });
    expect(map(new InvalidRunFiltersError('unknown collection(s): pizza'))).toMatchObject({ status: 400, body: { error: 'Bad Request' } });
    expect(map(new InvalidCursorError('invalid cursor "x"'))).toMatchObject({ status: 400, body: { message: 'invalid cursor "x"' } });
  });

  it('keeps validation issues from the Zod pipe', () => {
    const e = new BadRequestException({ message: 'Request validation failed', issues: [{ path: 'limit', message: 'Too small' }] });
    expect(map(e)).toEqual({
      status: 400,
      body: { statusCode: 400, error: 'Bad Request', message: 'Request validation failed', issues: [{ path: 'limit', message: 'Too small' }] },
    });
    expect(map(new NotFoundException('Cannot GET /nope'))).toMatchObject({ status: 404, body: { message: 'Cannot GET /nope' } });
  });

  it('answers 503 with the health report itself', () => {
    const report = { status: 'down' } as unknown as HealthReport;
    expect(map(new HealthCheckFailedError(report))).toEqual({ status: 503, body: report });
  });

  it('never leaks internals of unknown errors', () => {
    const err = new Error('connect ECONNREFUSED 10.0.0.5:27017 password=hunter2');
    const out = map(err);
    expect(out).toEqual({ status: 500, body: { statusCode: 500, error: 'Internal Server Error', message: 'Internal server error' } });
    expect(JSON.stringify(out)).not.toMatch(/ECONNREFUSED|hunter2|at .*\.ts/);
  });
});
