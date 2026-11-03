/**
 * xbyte handlers, end-to-end through the core runner, on trimmed real fixtures
 * (test/fixtures/xbyte). No database. Constructed variants of real docs are marked.
 */
import type { FixtureDoc as Document } from '../../../test/support/fixtures';
import { DomainRecord, PipelineResult, RawDocument, RecordOf, runPipeline } from '../../core';
import { loadFixtureDocs, loadRawFixtures } from '../../../test/support/fixtures';
import { RAW_COLLECTIONS } from './mappings';
import { createXbyteAdapter } from './xbyte.adapter';

const adapter = createXbyteAdapter({ batchSizeDefault: 200, batchSizeMenus: 25 });
const run = (docs: RawDocument[]): PipelineResult => runPipeline(docs, adapter);
const of = <E extends DomainRecord['entity']>(result: PipelineResult, entity: E) =>
  result.records.filter((r): r is RecordOf<E> => r.entity === entity);

const locations = () => loadRawFixtures('xbyte/locations.json', RAW_COLLECTIONS.locations);
const restaurants = () => loadRawFixtures('xbyte/restaurants.json', RAW_COLLECTIONS.restaurants);
const menus = () => loadRawFixtures('xbyte/menus.json', RAW_COLLECTIONS.menus);
const menuById = (id: string) => menus().find((d) => d.id === id)!;

const ERROR_MENU = '6a607b4ca08982f2261e393e'; // {Message: "This is not restaurant page (Talabat)."}
const COLLISION_MENU = '6a607b4ca08982f2261e3948'; // outlet 34858 / vendor 19770: Picks and Bites share 2796833705
const FLOAT_MENU = '6a607edba08982f2261e5d76'; // outlet 749293: float prices, a null image
const REAL_DUP_MENU = '6a607b52a08982f2261e39dd'; // outlet 708121: "Offers" and "Add On" share 2583617858

/** A RawDocument rebuilt from a deep-copied, edited fixture doc (constructed variants). */
const variant = (file: string, collection: string, index: number, edit: (doc: Document) => void): RawDocument => {
  const doc = loadFixtureDocs(file)[index];
  edit(doc);
  return { id: doc._id.toHexString(), collection, sourceTs: doc.createdAt, body: doc };
};

describe('xbyte adapter', () => {
  describe('menus', () => {
    it('error menu ("not restaurant page") -> 1 PROVIDER_ERROR, 0 records', () => {
      const result = run([menuById(ERROR_MENU)]);
      expect(result.records).toEqual([]);
      expect(result.issues).toEqual([
        expect.objectContaining({ reason: 'PROVIDER_ERROR', severity: 'error', stage: 'validate', details: { message: 'This is not restaurant page (Talabat).' } }),
      ]);
    });

    it('Picks/Bites id collision -> Picks is no category, featured ids set, Bites once, shared items featured with a real category', () => {
      const result = run([menuById(COLLISION_MENU)]);
      const [menu] = of(result, 'menu');
      const names = menu.data.categories.map((c) => c.name);

      expect(names.some((n) => /picks for you/i.test(n))).toBe(false);
      expect(names.filter((n) => n === 'Bites')).toHaveLength(1);
      expect(menu.data.categories.find((c) => c.name === 'Bites')?.categoryId).toBe('2796833705');
      expect(menu.data.featuredItemIds.length).toBeGreaterThan(0);

      const items = new Map(of(result, 'menuItem').map((i) => [i.key.itemId, i.data]));
      const realCategoryIds = new Set(menu.data.categories.map((c) => c.categoryId));
      for (const id of menu.data.featuredItemIds) {
        const item = items.get(id)!;
        expect(item.isFeatured).toBe(true);
        expect(item.categoryIds.length).toBeGreaterThan(0); // every Picks item here also sits in a real category
        expect(item.categoryIds.every((c) => realCategoryIds.has(c))).toBe(true);
      }
      const bites = menu.data.categories.find((c) => c.name === 'Bites')!;
      expect(bites.itemIds.some((id) => menu.data.featuredItemIds.includes(id))).toBe(true); // in both Picks and Bites
      expect(result.issues).toEqual([]); // Picks vs real collision is resolved, not warned about
    });

    it('float prices -> integer priceMinor; null image -> imageUrl null', () => {
      const raw = menuById(FLOAT_MENU);
      const sourceItems = (raw.body as Document).payload.results[0].category.flatMap((c: Document) => c.items) as Document[];
      const floatItem = sourceItems.find((i) => !Number.isInteger(i.price))!;
      const nullImageItem = sourceItems.find((i) => i.image === null)!;

      const items = new Map(of(run([raw]), 'menuItem').map((i) => [i.key.itemId, i.data]));
      const mapped = items.get(String(floatItem.item_id))!;
      expect(Number.isInteger(mapped.priceMinor)).toBe(true);
      expect(mapped.priceMinor).toBe(Math.round(floatItem.price * 100));
      expect(mapped.currency).toBe('AED');
      expect(items.get(String(nullImageItem.item_id))!.imageUrl).toBeNull();
    });

    it('real categories sharing an id are merged into the first, with a non-blocking DUPLICATE_CONFLICT warning', () => {
      const result = run([menuById(REAL_DUP_MENU)]);
      const [menu] = of(result, 'menu');
      const merged = menu.data.categories.filter((c) => c.categoryId === '2583617858');
      expect(merged).toHaveLength(1);
      expect(merged[0].name).toBe('Offers');
      expect(menu.data.categories.map((c) => c.position)).toEqual(menu.data.categories.map((_, i) => i));
      expect(result.issues).toEqual([
        expect.objectContaining({ reason: 'DUPLICATE_CONFLICT', severity: 'warning', details: { categoryId: '2583617858', names: ['Offers', 'Add On'] } }),
      ]);
      expect(result.counters).toMatchObject({ okDocuments: 1, errors: 0, warnings: 1 });
      // the "Add On" item is still in the menu, under the merged category
      const sourceAddOn = (menuById(REAL_DUP_MENU).body as Document).payload.results[0].category.find((c: Document) => c.category_name === 'Add On');
      for (const it of sourceAddOn.items) expect(merged[0].itemIds).toContain(String(it.item_id));
    });

    it('menu restaurant: outletCode is the key, payload id is vendorId, menu-owned fields only', () => {
      const [restaurant] = of(run([menuById(COLLISION_MENU)]), 'restaurant');
      expect(restaurant.key).toEqual({ platform: 'talabat', externalId: '34858' });
      expect(restaurant.data.vendorId).toBe('19770');
      expect(restaurant.data.contact).toBeNull(); // "00000-00000"
      expect(restaurant.data.geo).toEqual({ type: 'Point', coordinates: [expect.any(Number), expect.any(Number)] });
      expect(restaurant.data.delivery?.currency).toBe('AED');
      expect(Object.keys(restaurant.data).sort()).toEqual(['address', 'contact', 'delivery', 'geo', 'logoUrl', 'name', 'rating', 'vendorId']);
    });

    it('outletCode that differs from the URL id -> SCHEMA_INVALID, no records (constructed)', () => {
      const doc = variant('xbyte/menus.json', RAW_COLLECTIONS.menus, 1, (d) => (d.payload.results[0].outletCode = 99999));
      const result = run([doc]);
      expect(result.records).toEqual([]);
      expect(result.issues).toEqual([expect.objectContaining({ reason: 'SCHEMA_INVALID', path: 'payload.results[0].outletCode' })]);
    });
  });

  describe('restaurants (listing pages)', () => {
    it('restaurant page -> N restaurant + N restaurantArea records, areaExternalId a string matching location_id', () => {
      const [page] = restaurants();
      const rows = (page.body as Document).payload.results as Document[];
      const result = run([page]);

      expect(of(result, 'restaurant')).toHaveLength(rows.length);
      expect(of(result, 'restaurantArea')).toHaveLength(rows.length);

      const zaab = of(run(locations()), 'area').find((a) => a.data.slug === 'al-zaab')!; // location_id 1468
      for (const edge of of(result, 'restaurantArea')) {
        expect(typeof edge.key.areaExternalId).toBe('string');
        expect(edge.key.areaExternalId).toBe(zaab.key.externalId);
      }
    });

    it('listing restaurant carries listing-owned fields only; URL parsed, query string stripped', () => {
      const [page] = restaurants();
      const row = (page.body as Document).payload.results[0];
      const outletId = /\/restaurant\/(\d+)\//.exec(row.restaurant_url)![1];
      const restaurant = of(run([page]), 'restaurant').find((r) => r.key.externalId === outletId)!;
      expect(Object.keys(restaurant.data).sort()).toEqual(['country', 'listing', 'slug']);
      expect(restaurant.data.country).toBe('uae');
      expect(restaurant.data.listing?.url).toBe(row.restaurant_url.split('?')[0]);
    });

    it('"Page limit exceeded" page and {"error": ""} page -> PROVIDER_ERROR, no records', () => {
      const [, pageLimit, errorPage] = restaurants();
      const result = run([pageLimit, errorPage]);
      expect(result.records).toEqual([]);
      expect(result.issues.map((i) => [i.sourceId, i.reason, i.path])).toEqual(
        [
          [pageLimit.id, 'PROVIDER_ERROR', 'payload.Page Error Message'],
          [errorPage.id, 'PROVIDER_ERROR', 'payload.error'],
        ].sort(),
      );
    });

    it('a row whose URL does not parse -> record-level SCHEMA_INVALID at results[i]; the rest of the page still processes (constructed)', () => {
      const doc = variant('xbyte/restaurants.json', RAW_COLLECTIONS.restaurants, 0, (d) => {
        d.payload.results[2].restaurant_url = 'https://www.talabat.com/uae/offers';
      });
      const rows = (doc.body as Document).payload.results.length;
      const result = run([doc]);
      expect(result.issues).toEqual([expect.objectContaining({ reason: 'SCHEMA_INVALID', severity: 'error', stage: 'map', path: 'payload.results[2].restaurant_url' })]);
      expect(of(result, 'restaurant')).toHaveLength(rows - 1);
      expect(of(result, 'restaurantArea')).toHaveLength(rows - 1);
      expect(result.counters).toMatchObject({ partialDocuments: 1 });
    });
  });

  describe('locations', () => {
    it('one area per result, keyed by location_id as a string; non-unique slugs stay separate areas', () => {
      const areas = of(run(locations()), 'area');
      expect(areas).toHaveLength(5);
      expect(areas.every((a) => typeof a.key.externalId === 'string')).toBe(true);
      expect(areas.filter((a) => a.data.slug === 'industrial-area').map((a) => a.key.externalId).sort()).toEqual(['3892', '5625']);
    });

    it('identical snapshots collapse in dedupe (the newest wins)', () => {
      const [doc] = locations();
      const later = { ...doc, id: 'ffffffffffffffffffffffff', sourceTs: new Date(doc.sourceTs.getTime() + 1000) };
      const result = run([doc, later]);
      expect(of(result, 'area')).toHaveLength(5);
      expect(result.counters.deduplicated).toBe(5);
      expect(of(result, 'area').every((a) => a.version.rawId === later.id)).toBe(true);
    });
  });

  describe('secrets', () => {
    const KEY = 'LEAKCHECK_9f3a2b7c';
    const withKey = (doc: Document) => {
      doc.endpoint = `https://xb-3748-restaurants-dataapi.xbyteapi.com/restaurant_menu/?api_key=${KEY}&domain=talabat`;
      doc.payload.request_log = { ...(doc.payload.request_log ?? {}), requests_url: doc.endpoint };
    };

    it('no API key appears in any issue, across every failure path', () => {
      const docs: RawDocument[] = [
        // every fixture, with a live-looking key injected
        ...['xbyte/locations.json', 'xbyte/restaurants.json', 'xbyte/menus.json'].flatMap((file, f) =>
          loadFixtureDocs(file).map((_, i) =>
            variant(file, [RAW_COLLECTIONS.locations, RAW_COLLECTIONS.restaurants, RAW_COLLECTIONS.menus][f], i, withKey),
          ),
        ),
        // constructed failures that put raw values into issue details
        variant('xbyte/menus.json', RAW_COLLECTIONS.menus, 0, (d) => {
          withKey(d);
          d.payload.Message = `upstream failed for ?api_key=${KEY}`;
        }),
        variant('xbyte/menus.json', RAW_COLLECTIONS.menus, 1, (d) => {
          withKey(d);
          d.payload.results[0].outletCode = 1;
        }),
        variant('xbyte/restaurants.json', RAW_COLLECTIONS.restaurants, 0, (d) => {
          withKey(d);
          d.payload.results[0].restaurant_url = `https://x.example/?api_key=${KEY}`;
        }),
        variant('xbyte/menus.json', RAW_COLLECTIONS.menus, 2, (d) => {
          withKey(d);
          d.payload.results[0].category[0].items[0].price = 'not a number';
        }),
      ];
      const result = run(docs);
      expect(result.issues.length).toBeGreaterThanOrEqual(6);
      expect(JSON.stringify(result.issues)).not.toContain(KEY);
      expect(JSON.stringify(result.records)).not.toContain(KEY);
    });
  });
});
