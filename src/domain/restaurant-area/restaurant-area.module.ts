import { Module } from '@nestjs/common';
import { RESTAURANT_AREA_REPOSITORY, RestaurantAreaRepository } from './restaurant-area.repository';

@Module({
  providers: [RestaurantAreaRepository, { provide: RESTAURANT_AREA_REPOSITORY, useExisting: RestaurantAreaRepository }],
  exports: [RESTAURANT_AREA_REPOSITORY],
})
export class RestaurantAreaModule {}
