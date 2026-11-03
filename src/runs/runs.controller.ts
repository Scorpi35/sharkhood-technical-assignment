import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import type { Run } from '../core';
import { ResumeReport, RunResumer } from '../queue/run-resumer.service';
import { ErrorsQuery, ErrorsQueryPipe, StartRunBody, StartRunBodyPipe } from './runs.http';
import { RunsService, StartedRun } from './runs.service';

/**
 * Runs HTTP API. Every method is a single service call: validation is done by
 * the pipes, and errors are mapped to status codes by the global exception filter.
 */
@Controller('runs')
export class RunsController {
  constructor(
    private readonly runs: RunsService,
    private readonly resumer: RunResumer,
  ) {}

  /** Start a run. 202 {runId, status}; 400 with Zod issue paths for an invalid body. */
  @Post()
  @HttpCode(202)
  start(@Body(StartRunBodyPipe) body: StartRunBody): Promise<StartedRun> {
    return this.runs.startRun(body);
  }

  /** The run: status, per-source progress, counters, timings, error sample. 404 if unknown. */
  @Get(':id')
  get(@Param('id') runId: string): Promise<Run> {
    return this.runs.getRunOrThrow(runId);
  }

  /** Quarantined errors and warnings, cursor-paginated. 404 if the run is unknown, 400 for a bad cursor. */
  @Get(':id/errors')
  errors(@Param('id') runId: string, @Query(ErrorsQueryPipe) query: ErrorsQuery): ReturnType<RunsService['listErrors']> {
    return this.runs.listErrors(runId, query);
  }

  /** Re-attach a run to the queue. 202 with the report; 404 unknown; 409 already finished. */
  @Post(':id/resume')
  @HttpCode(202)
  resume(@Param('id') runId: string): Promise<ResumeReport> {
    return this.resumer.resume(runId);
  }
}
