/**
 * The one place that maps sample files to raw collections.
 * Paths are relative to the working directory (repo root locally, /app in Docker).
 */
export interface RawSource {
  readonly file: string;
  readonly collection: string;
}

export const RAW_SOURCES: readonly RawSource[] = [
  { file: 'data/raw/xbyte-raw-locations.json', collection: 'xbyte_raw_locations' },
  { file: 'data/raw/xbyte-raw-restaurants.json', collection: 'xbyte_raw_restaurants' },
  { file: 'data/raw/xbyte-raw-menus.json', collection: 'xbyte_raw_menus' },
];
