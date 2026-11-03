import { Module } from '@nestjs/common';
import { AREA_REPOSITORY, AreaRepository } from './area.repository';

@Module({
  providers: [AreaRepository, { provide: AREA_REPOSITORY, useExisting: AreaRepository }],
  exports: [AREA_REPOSITORY],
})
export class AreaModule {}
