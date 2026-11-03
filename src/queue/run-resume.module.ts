import { Injectable, Logger, Module, OnApplicationBootstrap } from '@nestjs/common';
import { RunsModule } from '../runs/runs.module';
import { RunResumer } from './run-resumer.service';

/** RunResumer, shared by POST /runs/:id/resume (api) and resume-on-boot (worker). Queues come from the global QueueModule. */
@Module({
  imports: [RunsModule],
  providers: [RunResumer],
  exports: [RunResumer],
})
export class RunResumeModule {}

/**
 * Worker role: on boot, re-attach every non-terminal run to the queue. After a
 * normal restart this finds every job still in Redis and changes nothing; after
 * Redis lost state it re-enqueues what is missing. A failure here is logged, not
 * fatal: the workers themselves are already running.
 */
@Injectable()
export class ResumeOnBoot implements OnApplicationBootstrap {
  private readonly logger = new Logger(ResumeOnBoot.name);

  constructor(private readonly resumer: RunResumer) {}

  async onApplicationBootstrap(): Promise<void> {
    try {
      const reports = await this.resumer.resumeAll();
      if (reports.length > 0) this.logger.log({ runs: reports }, 'Resume on boot');
    } catch (err) {
      this.logger.error({ err }, 'Resume on boot failed');
    }
  }
}
