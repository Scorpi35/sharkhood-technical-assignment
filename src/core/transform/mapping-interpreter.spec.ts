import { ok } from '../pipeline/types';
import type { ProviderAdapter } from '../providers/provider-adapter';
import { ProviderRegistry, ProviderRegistryError } from '../providers/provider-registry';
import { applyMapping, compileMapping, FieldMapping, mappingFor, MappingError, validateMapping } from './mapping-interpreter';
import { TransformRegistry, TransformRegistryError, transformFactories } from './transform-registry';

/** A provider-style registry: built-ins plus two bound, parameterised transforms. */
const registry = new TransformRegistry({
  contactPlaceholder: transformFactories.placeholderToNull([/^0+-0+$/]),
  outletIdFromUrl: transformFactories.extractUrlId(/\/restaurant\/(\d+)\//),
});

// Shaped like a real menus payload.results[0] (trimmed).
const menuRestaurant = {
  name: 'Bombay Box ',
  latitude: '25.23018894217186',
  longitude: '55.31936521220774',
  rate: 0,
  deliveryFee: '9',
  DeliveryTime: '25-40 mins',
  Contact: '00000-00000',
  'Restaurant Address': 'Al Karama',
  url: 'https://www.talabat.com/uae/restaurant/757815/bombay-box-oud-metha?aid=1280',
};

const mapping: FieldMapping[] = [
  { target: 'restaurant.name', from: 'name', transforms: ['trimCollapse'] },
  { target: 'restaurant.geo', from: ['latitude', 'longitude'], transforms: ['toGeoPoint'] },
  { target: 'restaurant.rating.value', from: 'rate', transforms: ['zeroToNull'] },
  { target: 'restaurant.delivery.feeMinor', from: 'deliveryFee', transforms: ['toMinorUnits'] },
  { target: 'restaurant.delivery.time', from: 'DeliveryTime', transforms: ['parseDurationRange'] },
  { target: 'restaurant.contact', from: 'Contact', transforms: ['contactPlaceholder'] },
  { target: 'restaurant.address.area', from: 'Restaurant Address', transforms: ['trimCollapse', 'emptyToNull'] },
  { target: 'restaurant.logo', from: 'logo' },
  { target: 'menu.categories', from: 'category' },
];

describe('mapping interpreter', () => {
  it('builds a nested object per entity with a dot-path setter, absent fields as null', () => {
    expect(applyMapping(menuRestaurant, mapping, registry)).toEqual({
      ok: true,
      value: {
        restaurant: {
          name: 'Bombay Box',
          geo: { type: 'Point', coordinates: [55.31936521220774, 25.23018894217186] },
          rating: { value: null },
          delivery: { feeMinor: 900, time: { minMinutes: 25, maxMinutes: 40 } },
          contact: null,
          address: { area: 'Al Karama' },
          logo: null,
        },
        menu: { categories: null },
      },
    });
  });

  it('reports a rejected value as SCHEMA_INVALID at the source path', () => {
    const out = applyMapping({ DeliveryTime: 'soon' }, mappingFor('restaurant', mapping), registry);
    expect(out).toEqual({
      ok: false,
      issue: expect.objectContaining({ reason: 'SCHEMA_INVALID', path: 'DeliveryTime', message: expect.stringMatching(/^parseDurationRange: /) }),
    });
  });

  it('rejects an unknown transform name when the mapping is compiled, before any data', () => {
    const typo: FieldMapping[] = [{ target: 'restaurant.name', from: 'name', transforms: ['trimColapse'] }];
    expect(() => compileMapping(typo, registry)).toThrow(MappingError);
    expect(() => compileMapping(typo, registry)).toThrow(/unknown transform "trimColapse"/);
  });

  it('rejects an unknown transform name when the adapter registers', () => {
    const adapter: ProviderAdapter = {
      provider: 'fake',
      platform: 'talabat',
      sources: [
        {
          rawCollection: 'fake_menus',
          mapping: [{ target: 'menuItem.priceMinor', from: 'price', transforms: ['toMinorUnitz'] }],
          transforms: registry,
          validate: (b) => ok(b),
          normalise: (v) => v,
          map: () => [],
        },
      ],
    };
    expect(() => new ProviderRegistry([adapter])).toThrow(ProviderRegistryError);
    expect(() => new ProviderRegistry([adapter])).toThrow(/fake \/ fake_menus: .*unknown transform "toMinorUnitz"/s);
  });

  it('reports every structural problem at once', () => {
    let error: MappingError | undefined;
    try {
      validateMapping([
        { target: 'pizza.name' as FieldMapping['target'], from: 'name' },
        { target: 'restaurant.rating', from: 'rate' },
        { target: 'restaurant.rating.value', from: 'rate' },
        { target: 'restaurant.name', from: '' },
        { target: 'restaurant.name', from: 'name' },
      ]);
    } catch (err) {
      error = err as MappingError;
    }
    expect(error?.problems).toEqual([
      expect.stringContaining('pizza.name: target must be'),
      expect.stringContaining('restaurant.name: empty "from" path'),
      expect.stringContaining('restaurant.name: mapped more than once'),
      expect.stringContaining('restaurant.rating: overlaps with restaurant.rating.value'),
    ]);
  });

  it('binds parameterised normalisers once, at registry construction', () => {
    expect(() => transformFactories.extractUrlId(/\/restaurant\/\d+\//)).toThrow(/capture group/);
    expect(() => transformFactories.placeholderToNull([/0/g])).toThrow(/g or y flag/);
    expect(() => new TransformRegistry({ trimCollapse: (v) => ok(v) })).toThrow(TransformRegistryError);
    expect(registry.get('outletIdFromUrl')!(menuRestaurant.url)).toEqual({ ok: true, value: 757815 });
  });
});
