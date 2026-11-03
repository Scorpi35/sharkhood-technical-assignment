import { DynamicModule, Module } from '@nestjs/common';
import { AppConfigModule } from './config/config.module';
import type { AppConfig } from './config/app-config';
import { DomainModule } from './domain/domain.module';
import { HealthController } from './health/health.controller';
import { MongoModule } from './infra/mongo/mongo.module';
import { LoggingModule } from './logging/logging.module';
import { ProvidersModule } from './providers/providers.module';
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
      imports: [AppConfigModule, LoggingModule, MongoModule, DomainModule, ProvidersModule],
      controllers: config.runsHttp ? [HealthController] : [],
      providers: config.runsWorker ? [WorkerHeartbeatService] : [],
    };
  }
}
