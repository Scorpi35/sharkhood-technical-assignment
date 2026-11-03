import { ok } from '../pipeline/types';
import type { ProviderAdapter, SourceHandler } from './provider-adapter';
import { ProviderRegistry, ProviderRegistryError } from './provider-registry';

const handler = (rawCollection: string): SourceHandler => ({
  rawCollection,
  validate: (b) => ok(b),
  normalise: (v) => v,
  map: () => [],
});
const adapter = (provider: string, ...collections: string[]): ProviderAdapter => ({
  provider,
  platform: 'example',
  sources: collections.map(handler),
});

describe('ProviderRegistry', () => {
  it('resolves the handler and adapter by raw collection', () => {
    const a = adapter('a', 'a_menus', 'a_areas');
    const b = adapter('b', 'b_menus');
    const registry = new ProviderRegistry([a, b]);
    expect(registry.resolve('b_menus').adapter).toBe(b);
    expect(registry.resolve('a_areas').handler.rawCollection).toBe('a_areas');
    expect(registry.rawCollections()).toEqual(['a_areas', 'a_menus', 'b_menus']);
  });

  it('rejects a raw collection claimed by two providers', () => {
    expect(() => new ProviderRegistry([adapter('a', 'shared'), adapter('b', 'shared')])).toThrow(ProviderRegistryError);
  });

  it('throws for an unknown raw collection', () => {
    expect(() => new ProviderRegistry([adapter('a', 'x')]).resolve('y')).toThrow(/no SourceHandler/);
  });
});
