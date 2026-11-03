import { Module } from '@nestjs/common';
import { DomainModule } from '../domain/domain.module';
import { ProvidersModule } from '../providers/providers.module';
import { RunsModule } from '../runs/runs.module';
import { BatchProcessor } from './batch.processor';
import { DispatchProcessor } from './dispatch.processor';

/** The BullMQ workers. Imported only for APP_ROLE worker / all; queues come from the global QueueModule. */
@Module({
  imports: [RunsModule, DomainModule, ProvidersModule],
  providers: [DispatchProcessor, BatchProcessor],
})
export class WorkerQueueModule {}
