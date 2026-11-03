import { Inject, Injectable } from '@nestjs/common';
import type { DomainRecord, EntityKind, EntityWriteResult, MenuKey, RecordOf, TargetWriter, WriteResult } from '../core';
import { AREA_REPOSITORY, AreaRepository } from './area/area.repository';
import { MENU_ITEM_REPOSITORY, MenuItemRepository } from './menu-item/menu-item.repository';
import { MENU_REPOSITORY, menuKeyString, MenuRepository } from './menu/menu.repository';
import { RESTAURANT_AREA_REPOSITORY, RestaurantAreaRepository } from './restaurant-area/restaurant-area.repository';
import { RESTAURANT_REPOSITORY, RestaurantRepository } from './restaurant/restaurant.repository';
import { EMPTY_OUTCOME, UpsertOutcome, versionString } from './shared/versioned-upsert';

type Grouped = { [E in EntityKind]: RecordOf<E>[] };

/**
 * TargetWriter that routes records to the per-entity repositories.
 *
 * Menu availability is reconciled against the *stored* menu snapshot version,
 * not just "the menu this batch wrote", so the result is the same whatever order
 * batches arrive in:
 *   1. upsert menus (version-guarded; an older snapshot is stale and changes nothing);
 *   2. read the stored menu version of every restaurant this batch touches;
 *   3. upsert items, with isAvailable=false for items older than that snapshot
 *      (a late, older batch cannot resurrect an item the newer menu dropped);
 *   4. retire stored items older than the snapshot (items that disappeared).
 * Step 4 runs after every batch, so concurrent batches converge too.
 */
@Injectable()
export class CompositeTargetWriter implements TargetWriter {
  constructor(
    @Inject(AREA_REPOSITORY) private readonly areas: AreaRepository,
    @Inject(RESTAURANT_REPOSITORY) private readonly restaurants: RestaurantRepository,
    @Inject(RESTAURANT_AREA_REPOSITORY) private readonly restaurantAreas: RestaurantAreaRepository,
    @Inject(MENU_REPOSITORY) private readonly menus: MenuRepository,
    @Inject(MENU_ITEM_REPOSITORY) private readonly menuItems: MenuItemRepository,
  ) {}

  async upsert(records: readonly DomainRecord[]): Promise<WriteResult> {
    const g = group(records);

    const [area, restaurant, restaurantArea, menu] = await Promise.all([
      this.areas.upsert(g.area),
      this.restaurants.upsert(g.restaurant),
      this.restaurantAreas.upsert(g.restaurantArea),
      this.menus.upsert(g.menu),
    ]);

    const touched = uniqueMenuKeys([...g.menu.map((r) => r.key), ...g.menuItem.map((r) => ({ platform: r.key.platform, restaurantExternalId: r.key.restaurantExternalId }))]);
    const menuVersions = touched.length > 0 ? await this.menus.findVersions(touched) : new Map<string, string>();

    const items = g.menuItem.map((r): RecordOf<'menuItem'> => {
      const stored = menuVersions.get(menuKeyString({ platform: r.key.platform, restaurantExternalId: r.key.restaurantExternalId }));
      return stored !== undefined && versionString(r.version) < stored ? { ...r, data: { ...r.data, isAvailable: false } } : r;
    });
    const menuItem = items.length > 0 ? await this.menuItems.upsert(items) : EMPTY_OUTCOME;

    const retired = await this.menuItems.retireOlderThan(
      touched.flatMap((key) => {
        const menuVersion = menuVersions.get(menuKeyString(key));
        return menuVersion === undefined ? [] : [{ key, menuVersion }];
      }),
    );

    const byEntity: Record<EntityKind, EntityWriteResult> = {
      area: pick(area),
      restaurant: pick(restaurant),
      restaurantArea: pick(restaurantArea),
      menu: pick(menu),
      menuItem: pick(menuItem),
    };
    const sum = (k: keyof EntityWriteResult) => Object.values(byEntity).reduce((n, r) => n + r[k], 0);
    return { written: sum('written'), unchanged: sum('unchanged'), stale: sum('stale'), retired, byEntity };
  }
}

const pick = ({ written, unchanged, stale }: UpsertOutcome): EntityWriteResult => ({ written, unchanged, stale });

function group(records: readonly DomainRecord[]): Grouped {
  const g: Grouped = { area: [], restaurant: [], restaurantArea: [], menu: [], menuItem: [] };
  for (const r of records) (g[r.entity] as DomainRecord[]).push(r);
  return g;
}

function uniqueMenuKeys(keys: readonly MenuKey[]): MenuKey[] {
  const seen = new Map<string, MenuKey>();
  for (const k of keys) seen.set(menuKeyString(k), { platform: k.platform, restaurantExternalId: k.restaurantExternalId });
  return [...seen.values()];
}
