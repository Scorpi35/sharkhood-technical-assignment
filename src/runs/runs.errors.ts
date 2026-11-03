import type { RunStatus } from '../core';

/** Errors the runs layer throws on purpose. The HTTP exception filter maps each to a status code. */

export class RunNotFoundError extends Error {
  override readonly name = 'RunNotFoundError';
  constructor(readonly runId: string) {
    super(`unknown run ${runId}`);
  }
}

/** The run already reached a terminal status, so the request has nothing to act on. */
export class RunAlreadyFinishedError extends Error {
  override readonly name = 'RunAlreadyFinishedError';
  constructor(
    readonly runId: string,
    readonly status: RunStatus,
  ) {
    super(`run ${runId} is already ${status}`);
  }
}

export class InvalidRunFiltersError extends Error {
  override readonly name = 'InvalidRunFiltersError';
}
