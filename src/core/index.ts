/**
 * Domain core: provider-agnostic, pure pipeline contracts, runner and ports.
 * Lint forbids importing src/providers, src/domain, mongodb, bullmq or @nestjs/*
 * values from here; infrastructure implements the ports in ./ports.
 */
export * from './pipeline/types';
export * from './pipeline/stage';
export * from './pipeline/runner';
export * from './pipeline/dedupe';
export * from './pipeline/stable-stringify';
export * from './providers/provider-adapter';
export * from './providers/provider-registry';
export * from './transform/normalisers';
export * from './transform/transform-registry';
export * from './transform/mapping-interpreter';
export * from './ports';
