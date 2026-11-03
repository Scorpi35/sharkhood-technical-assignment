import { Module } from '@nestjs/common';
import { TARGET_WRITER } from '../core';
import { AreaModule } from './area/area.module';
import { CompositeTargetWriter } from './composite-target-writer';
import { MenuItemModule } from './menu-item/menu-item.module';
import { MenuModule } from './menu/menu.module';
import { RestaurantAreaModule } from './restaurant-area/restaurant-area.module';
import { RestaurantModule } from './restaurant/restaurant.module';
import { RunMetadataModule } from './run-metadata/run-metadata.module';

/** All target collections. Each entity module creates its indexes on init. Exposes TARGET_WRITER. */
@Module({
  imports: [AreaModule, RestaurantModule, RestaurantAreaModule, MenuModule, MenuItemModule, RunMetadataModule],
  providers: [{ provide: TARGET_WRITER, useClass: CompositeTargetWriter }],
  exports: [TARGET_WRITER],
})
export class DomainModule {}
