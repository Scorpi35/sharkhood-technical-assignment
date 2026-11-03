import { Module } from '@nestjs/common';
import { MENU_REPOSITORY, MenuRepository } from './menu.repository';

@Module({
  providers: [MenuRepository, { provide: MENU_REPOSITORY, useExisting: MenuRepository }],
  exports: [MENU_REPOSITORY],
})
export class MenuModule {}
