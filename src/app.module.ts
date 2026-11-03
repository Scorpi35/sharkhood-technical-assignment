import { DynamicModule, Module } from '@nestjs/common';
import { AppConfigModule } from './config/config.module';
import type { AppConfig } from './config/app-config';
import { APP_FILTER } from '@nestjs/core';
import { AllExceptionsFilter } from './common/all-exceptions.filter';
import { DomainModule } from './domain/domain.module';
import { HealthController } from './health/health.controller';
import { HealthService } from './health/health.service';
import { MongoModule } from './infra/mongo/mongo.module';
import { LoggingModule } from './logging/logging.module';
import { ProvidersModule } from './providers/providers.module';
import { QueueModule } from './queue/queue.module';
import { RunResumeModule } from './queue/run-resume.module';
import { WorkerQueueModule } from './queue/worker-queue.module';
import { RunsController } from './runs/runs.controller';
import { RunsModule } from './runs/runs.module';
import { WorkerHeartbeatService } from './worker/worker-heartbeat.service';

/**
 * Composition root. The role decides what gets wired: HTTP controllers for
 * api/all, background processing for worker/all.
 */
@Module({})
export class AppModule {
  static forRole(config: AppConfig): DynamicModule {
    return {
      module: AppModule,
      // ProvidersModule builds the ProviderRegistry, which validates every mapping at startup.
      // MongoModule connects once; DomainModule creates every index on init.
      // QueueModule (producers) in every role; WorkerQueueModule (BullMQ workers) only where work runs.
      imports: [
        AppConfigModule,
        LoggingModule,
        MongoModule,
        DomainModule,
        ProvidersModule,
        RunsModule,
        QueueModule,
        ...(config.runsHttp ? [RunResumeModule] : []),
        ...(config.runsWorker ? [WorkerQueueModule] : []),
      ],
      controllers: config.runsHttp ? [HealthController, RunsController] : [],
      providers: [
        ...(config.runsHttp ? [HealthService, { provide: APP_FILTER, useClass: AllExceptionsFilter }] : []),
        ...(config.runsWorker ? [WorkerHeartbeatService] : []),
      ],
    };
  }
}
