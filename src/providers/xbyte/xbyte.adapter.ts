import type { ProviderAdapter } from '../../core';
import { createLocationsHandler } from './handlers/locations.handler';
import { createMenusHandler } from './handlers/menus.handler';
import { createRestaurantsHandler } from './handlers/restaurants.handler';
import { KNOWN_PLATFORMS, PROVIDER } from './mappings';

export interface XbyteAdapterOptions {
  /** Raw docs per batch for locations and listings. */
  readonly batchSizeDefault?: number;
  /** Raw docs per batch for menus (~19 KB avg, up to 154 KB each). */
  readonly batchSizeMenus?: number;
}

/** The xbyte provider: three source handlers, all xbyte knowledge lives under this folder. */
export function createXbyteAdapter(options: XbyteAdapterOptions = {}): ProviderAdapter {
  return {
    provider: PROVIDER,
    platform: KNOWN_PLATFORMS[0],
    sources: [
      createLocationsHandler(options.batchSizeDefault),
      createRestaurantsHandler(options.batchSizeDefault),
      createMenusHandler(options.batchSizeMenus),
    ],
  };
}
