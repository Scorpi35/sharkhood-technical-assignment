import type { ProviderAdapter, SourceHandler } from './provider-adapter';

export interface ResolvedSource {
  readonly adapter: ProviderAdapter;
  readonly handler: SourceHandler;
}

/** Thrown for wiring mistakes (unknown or doubly registered raw collection). Not a data problem. */
export class ProviderRegistryError extends Error {
  override readonly name = 'ProviderRegistryError';
}

/** Resolves the SourceHandler (and its adapter) responsible for a raw collection. */
export class ProviderRegistry {
  private readonly byCollection = new Map<string, ResolvedSource>();

  constructor(adapters: readonly ProviderAdapter[]) {
    for (const adapter of adapters) {
      for (const handler of adapter.sources) {
        const existing = this.byCollection.get(handler.rawCollection);
        if (existing) {
          throw new ProviderRegistryError(
            `raw collection "${handler.rawCollection}" is registered by both "${existing.adapter.provider}" and "${adapter.provider}"`,
          );
        }
        this.byCollection.set(handler.rawCollection, { adapter, handler });
      }
    }
  }

  resolve(rawCollection: string): ResolvedSource {
    const found = this.byCollection.get(rawCollection);
    if (!found) throw new ProviderRegistryError(`no SourceHandler registered for raw collection "${rawCollection}"`);
    return found;
  }

  has(rawCollection: string): boolean {
    return this.byCollection.has(rawCollection);
  }

  rawCollections(): string[] {
    return [...this.byCollection.keys()].sort();
  }
}
