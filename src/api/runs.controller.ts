import { ConflictException, Controller, HttpCode, NotFoundException, Param, Post } from '@nestjs/common';
import { ResumeReport, RunResumer, UnknownRunError } from '../queue/run-resumer.service';

/** Runs HTTP API. Thin: every endpoint is one service call. */
@Controller('runs')
export class RunsController {
  constructor(private readonly resumer: RunResumer) {}

  /**
   * Re-attach a run to the queue: re-enqueue dispatch jobs and unsettled batches
   * missing from Redis, and finish an interrupted finalisation. Idempotent.
   * 202 with the report; 404 for an unknown run; 409 if the run had already finished.
   */
  @Post(':id/resume')
  @HttpCode(202)
  async resume(@Param('id') runId: string): Promise<ResumeReport> {
    let report: ResumeReport;
    try {
      report = await this.resumer.resume(runId);
    } catch (err) {
      if (err instanceof UnknownRunError) throw new NotFoundException(err.message);
      throw err;
    }
    if (report.alreadyTerminal) throw new ConflictException({ message: `run ${runId} is already ${report.status}`, status: report.status });
    return report;
  }
}
