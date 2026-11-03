import { Module } from '@nestjs/common';
import { PROVIDER_REGISTRY, ProviderAdapter, ProviderRegistry } from '../core';
import { XBYTE_ADAPTER, XbyteModule } from './xbyte/xbyte.module';

/**
 * Builds the ProviderRegistry from every provider module. Construction validates
 * each handler's mapping, so a bad mapping fails application startup.
 * Adding a provider: import its module and add its adapter token to `inject`.
 */
@Module({
  imports: [XbyteModule],
  providers: [
    {
      provide: PROVIDER_REGISTRY,
      inject: [XBYTE_ADAPTER],
      useFactory: (...adapters: ProviderAdapter[]) => new ProviderRegistry(adapters),
    },
  ],
  exports: [PROVIDER_REGISTRY],
})
export class ProvidersModule {}
