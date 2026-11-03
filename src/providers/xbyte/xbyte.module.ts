import { Module } from '@nestjs/common';
import { AppConfig } from '../../config/app-config';
import { createXbyteAdapter } from './xbyte.adapter';

export const XBYTE_ADAPTER = Symbol('XbyteAdapter');

/** Provides the xbyte ProviderAdapter, sized from config. ProvidersModule registers it. */
@Module({
  providers: [
    {
      provide: XBYTE_ADAPTER,
      inject: [AppConfig],
      useFactory: (config: AppConfig) =>
        createXbyteAdapter({ batchSizeDefault: config.batch.defaultSize, batchSizeMenus: config.batch.menusSize }),
    },
  ],
  exports: [XBYTE_ADAPTER],
})
export class XbyteModule {}
