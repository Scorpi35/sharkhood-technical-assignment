# Submission

**What was built.** A NestJS data factory that migrates the xbyte/talabat
samples from a raw database into a deduplicated, platform-keyed domain model.
Work is `_id`-range batches on BullMQ, with retries, dead letters and
resume-on-boot. Every write is a version-guarded idempotent upsert, so a second
run writes nothing (identical fingerprint). Killing a worker mid-run, or losing
Redis, recovers without re-running completed batches; this was verified on
Docker and in an end-to-end test.

**What was left out.** A second provider, incremental (CDC) ingestion,
metrics and tracing, API auth, replay of dead batches, and per-run flagging
of zero-price items. See README → Known gaps.

**Look at first.**
1. `docs/DATA_ANALYSIS.md`: the data and the reasoning.
2. `src/providers/xbyte/mappings.ts`: all provider knowledge, declarative.
3. `src/domain/shared/versioned-upsert.ts` and `src/runs/runs.service.ts`:
   idempotency and exactly-once accounting.
4. `test/integration/factory.int-spec.ts`: seed → run → verify, idempotency, a killed worker.
