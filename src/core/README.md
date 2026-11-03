# src/core: provider-agnostic pipeline

Pure contracts, runner and ports. No provider-specific code, Mongo or BullMQ here (lint-enforced).
`runPipeline(raw, adapter)` runs validate → normalise → map per document, then dedupes the batch ("newest sourceTs wins").

**Adding a provider** (code goes in `src/providers/<name>/`, never in core):

1. **Implement a `SourceHandler` per raw collection.** `validate` returns `fail({reason, message})` for bad data and never throws. `normalise` cleans values. `map` emits `DomainRecordDraft`s; the runner stamps `version` and `source`.
2. **Write the mapping** as declarative `FieldMapping[]` (`{ target: 'restaurant.name', from: 'name', transforms: ['trimCollapse'] }`). Names resolve in a `TransformRegistry` (the built-ins in `transform/`, plus your own bound via `transformFactories`). Call `compileMapping` at module init; unknown names throw there.
3. **Register.** Export a `ProviderAdapter { provider, platform, sources }` and add it to the `ProviderRegistry`. Each raw collection can belong to only one handler.

Key on `platform`, not `provider`. Throwing means "bug" (quarantined as `TRANSFORM_ERROR`). Ports (`ports/`) are interfaces plus Symbol DI tokens.
