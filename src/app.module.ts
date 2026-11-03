import { DynamicModule, Module } from '@nestjs/common';
import { AppConfigModule } from './config/config.module';
import type { AppConfig } from './config/app-config';
import { HealthController } from './health/health.controller';
import { LoggingModule } from './logging/logging.module';
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
      imports: [AppConfigModule, LoggingModule],
      controllers: config.runsHttp ? [HealthController] : [],
      providers: config.runsWorker ? [WorkerHeartbeatService] : [],
    };
  }
}
