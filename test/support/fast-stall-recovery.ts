/**
 * Side-effect module: import it FIRST in a spec that kills workers. BullMQ processor
 * options (stall recovery) are read when src/queue/queue.constants.ts is imported, so
 * these must be in process.env before any import that pulls in the queue code.
 * Jest gives each test file its own process.env, so other suites keep the defaults.
 */
export const FAST_LOCK_DURATION_MS = 3000;
export const FAST_STALLED_INTERVAL_MS = 1000;
process.env.WORKER_LOCK_DURATION_MS = String(FAST_LOCK_DURATION_MS);
process.env.WORKER_STALLED_INTERVAL_MS = String(FAST_STALLED_INTERVAL_MS);
