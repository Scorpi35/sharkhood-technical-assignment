import { Module } from '@nestjs/common';
import { CLOCK, Clock } from '../core';
import { RunMetadataModule } from '../domain/run-metadata/run-metadata.module';
import { ProvidersModule } from '../providers/providers.module';
import { RunsService } from './runs.service';

const systemClock: Clock = () => new Date();

/**
 * Run records, batches and quarantine. Exports RunsService only; repositories stay internal.
 * DISPATCH_QUEUE comes from the global QueueModule (or a stub in tests).
 */
@Module({
  imports: [RunMetadataModule, ProvidersModule],
  providers: [RunsService, { provide: CLOCK, useValue: systemClock }],
  exports: [RunsService],
})
export class RunsModule {}
