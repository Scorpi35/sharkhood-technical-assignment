/**
 * Wall-clock time for run metadata (the only place the clock is used). Core never
 * calls it; services outside core get it injected, so tests can pin time.
 */
export const CLOCK = Symbol('Clock');
export type Clock = () => Date;
