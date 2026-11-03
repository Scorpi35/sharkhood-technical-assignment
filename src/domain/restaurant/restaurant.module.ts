import { Module } from '@nestjs/common';
import { RESTAURANT_REPOSITORY, RestaurantRepository } from './restaurant.repository';

@Module({
  providers: [RestaurantRepository, { provide: RESTAURANT_REPOSITORY, useExisting: RestaurantRepository }],
  exports: [RESTAURANT_REPOSITORY],
})
export class RestaurantModule {}
