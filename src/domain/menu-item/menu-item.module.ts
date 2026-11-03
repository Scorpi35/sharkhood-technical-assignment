import { Module } from '@nestjs/common';
import { MENU_ITEM_REPOSITORY, MenuItemRepository } from './menu-item.repository';

@Module({
  providers: [MenuItemRepository, { provide: MENU_ITEM_REPOSITORY, useExisting: MenuItemRepository }],
  exports: [MENU_ITEM_REPOSITORY],
})
export class MenuItemModule {}
