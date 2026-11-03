import { Module } from '@nestjs/common';
import { DomainModule } from '../domain/domain.module';
import { ProvidersModule } from '../providers/providers.module';
import { RunsModule } from '../runs/runs.module';
import { BatchProcessor } from './batch.processor';
import { DispatchProcessor } from './dispatch.processor';
import { ResumeOnBoot, RunResumeModule } from './run-resume.module';

/** The BullMQ workers plus resume-on-boot. Imported only for APP_ROLE worker / all; queues come from the global QueueModule. */
@Module({
  imports: [RunsModule, DomainModule, ProvidersModule, RunResumeModule],
  providers: [DispatchProcessor, BatchProcessor, ResumeOnBoot],
})
export class WorkerQueueModule {}
