import {
  DomainRecordDraft,
  fail,
  Issue,
  MenuCategory as DomainMenuCategory,
  MenuItemData,
  ok,
  RestaurantData,
  SourceHandler,
  stableStringify,
  StageOutcome,
  toIdString,
  warning,
} from '../../../core';
import { atPath, issueOf, validateEnvelope } from '../envelope';
import { compiled, COUNTRY_CURRENCY, FEATURED_CATEGORY_NAME_PATTERNS, MENUS_MAPPING, RAW_COLLECTIONS, XBYTE_TRANSFORMS } from '../mappings';
import { MenuItem, MenuRestaurant, MenusDoc, menusDocSchema } from '../schemas';

type Valid = MenusDoc & { platform: string };
interface Normalised {
  readonly platform: string;
  readonly restaurantUrl: string;
  readonly restaurant: MenuRestaurant;
}

const AT = 'payload.results[0]';
const idOf = (v: string | number): string => (toIdString(v) as { value: string }).value; // ids are schema-validated
const isFeatured = (name: string): boolean => FEATURED_CATEGORY_NAME_PATTERNS.some((p) => p.test(name.trim()));

/**
 * xbyte_raw_menus: unwrap results[0] into
 *   - a restaurant record with menu-owned fields (keyed by outletCode, which must equal the URL id),
 *   - a menu record (ordered real categories + featuredItemIds),
 *   - one menuItem record per unique item_id.
 * "Picks for you" style categories are featured, never categories. Real categories
 * sharing a category_id are merged (first position wins) with a warning.
 */
export function createMenusHandler(batchSize?: number): SourceHandler<Valid, Normalised> {
  return {
    rawCollection: RAW_COLLECTIONS.menus,
    batchSize,
    mapping: MENUS_MAPPING,
    transforms: XBYTE_TRANSFORMS,
    validate: (body) => validateEnvelope(menusDocSchema, body),
    normalise: (doc) => ({ platform: doc.platform, restaurantUrl: doc.params.restaurant_url, restaurant: doc.payload.results[0] }),
    map: (n) => mapMenu(n),
  };
}

function mapMenu(n: Normalised): StageOutcome<DomainRecordDraft>[] {
  const r = n.restaurant;

  // --- identity: everything below is keyed on it, so any problem here drops the document
  const urlOutlet = compiled.urlOutletId(n.restaurantUrl);
  const urlCountry = compiled.urlCountry(n.restaurantUrl);
  if (!urlOutlet.ok || !urlCountry.ok) {
    const i = (!urlOutlet.ok ? urlOutlet.issue : (urlCountry as { issue: Issue }).issue) as Issue;
    return [fail(issueOf({ ...i, path: 'params.restaurant_url', details: { restaurant_url: n.restaurantUrl } }))];
  }
  const externalId = idOf(r.outletCode);
  if (externalId !== idOf(urlOutlet.value as string)) {
    return [
      fail(
        issueOf({
          reason: 'SCHEMA_INVALID',
          message: `outletCode ${externalId} does not match the restaurant_url outlet id ${String(urlOutlet.value)}`,
          path: `${AT}.outletCode`,
          details: { outletCode: r.outletCode, urlOutletId: urlOutlet.value },
        }),
      ),
    ];
  }
  const country = urlCountry.value as string;
  const currency = COUNTRY_CURRENCY[country];
  if (!currency) {
    return [fail(issueOf({ reason: 'SCHEMA_INVALID', message: `no currency mapped for country "${country}"`, path: 'params.restaurant_url' }))];
  }
  const key = { platform: n.platform, restaurantExternalId: externalId };
  const out: StageOutcome<DomainRecordDraft>[] = [];

  // --- restaurant (menu-owned fields)
  const restaurant = compiled.menuRestaurant({ ...r, _currency: currency });
  out.push(
    restaurant.ok
      ? ok({ entity: 'restaurant', key: { platform: n.platform, externalId }, data: restaurant.value.restaurant as RestaurantData })
      : fail(atPath(restaurant.issue, AT)),
  );

  // --- categories: split featured vs real; merge real categories that share an id
  const warnings: Issue[] = [];
  const real = new Map<string, { categoryId: string; name: string; itemIds: string[] }>();
  const featuredIds: string[] = [];
  const realIdsByItem = new Map<string, string[]>();
  const firstSeen = new Map<string, { item: MenuItem; path: string; sig: string }>();

  r.category.forEach((c, ci) => {
    const catPath = `${AT}.category[${ci}]`;
    const itemIds = c.items.map((it, ii) => {
      const itemId = idOf(it.item_id);
      const sig = stableStringify([it.item_name, it.description, it.price, it.rating, it.image]);
      const seen = firstSeen.get(itemId);
      if (!seen) {
        firstSeen.set(itemId, { item: it, path: `${catPath}.items[${ii}]`, sig });
      } else if (seen.sig !== sig) {
        warnings.push(
          warning({
            reason: 'DUPLICATE_CONFLICT',
            message: `item ${itemId} differs between categories; the first occurrence (${seen.path}) is kept`,
            path: `${catPath}.items[${ii}]`,
          }),
        );
      }
      return itemId;
    });

    if (isFeatured(c.category_name)) {
      for (const id of itemIds) if (!featuredIds.includes(id)) featuredIds.push(id);
      return;
    }
    const categoryId = idOf(c.category_id);
    const existing = real.get(categoryId);
    if (existing) {
      warnings.push(
        warning({
          reason: 'DUPLICATE_CONFLICT',
          message: `category_id ${categoryId} is used by "${existing.name}" and "${c.category_name}"; merged into the first`,
          path: catPath,
          details: { categoryId, names: [existing.name, c.category_name] },
        }),
      );
    }
    const target = existing ?? { categoryId, name: c.category_name.trim().replace(/\s+/g, ' '), itemIds: [] };
    if (!existing) real.set(categoryId, target);
    for (const id of itemIds) {
      if (!target.itemIds.includes(id)) target.itemIds.push(id);
      const cats = realIdsByItem.get(id) ?? [];
      if (!cats.includes(categoryId)) realIdsByItem.set(id, [...cats, categoryId]);
    }
  });

  // --- items: one record per unique item_id; a failed item is removed from the menu too
  const failedItems = new Set<string>();
  for (const [itemId, { item, path }] of firstSeen) {
    const mapped = compiled.menuItem({ ...item, _currency: currency });
    if (!mapped.ok) {
      failedItems.add(itemId);
      out.push(fail(atPath(mapped.issue, path)));
      continue;
    }
    const data: MenuItemData = {
      ...(mapped.value.menuItem as Omit<MenuItemData, 'categoryIds' | 'isFeatured' | 'isAvailable'>),
      categoryIds: realIdsByItem.get(itemId) ?? [],
      isFeatured: featuredIds.includes(itemId),
      isAvailable: true,
    };
    out.push(ok({ entity: 'menuItem', key: { ...key, itemId }, data }));
  }

  // --- menu: ordered real categories (first-occurrence position) and featured ids
  const keep = (id: string) => !failedItems.has(id);
  const categories: DomainMenuCategory[] = [...real.values()].map((c, position) => ({
    categoryId: c.categoryId,
    name: c.name,
    position,
    itemIds: c.itemIds.filter(keep),
  }));
  out.push(ok({ entity: 'menu', key, data: { categories, featuredItemIds: featuredIds.filter(keep) } }, warnings.map((w) => issueOf(w))));
  return out;
}
