-- Avis hardening: concurrency backstops + a positive-cadence guard.

-- 1. At most ONE active review-generation job globally — the DB-level
--    single-flight backstop the ai_assign pattern uses (the SELECT hasActive()
--    gate alone is check-then-insert racy when a manual click and a scheduled
--    tick land in the same window). Index the partial predicate's value (always
--    `true` for indexed rows) so a second active INSERT trips 23505.
CREATE UNIQUE INDEX IF NOT EXISTS "review_generation_jobs_one_active"
  ON "review_generation_jobs" (("status" IN ('queued','running')))
  WHERE "status" IN ('queued','running');--> statement-breakpoint

-- 2. Enforce the single-row invariant on review_schedule (get() seeds a row on
--    first access; concurrent cold-starts could otherwise create two). `id IS
--    NOT NULL` is true for every row → unique index ⇒ at most one row.
CREATE UNIQUE INDEX IF NOT EXISTS "review_schedule_singleton"
  ON "review_schedule" (("id" IS NOT NULL));--> statement-breakpoint

-- 3. Defense-in-depth: cadence must be positive (the save action clamps to ≥1,
--    but a 0/negative value written out-of-band would make the schedule fire
--    every tick). Mirrors the rating/status CHECKs.
ALTER TABLE "review_schedule" DROP CONSTRAINT IF EXISTS "review_schedule_cadence_chk";--> statement-breakpoint
ALTER TABLE "review_schedule" ADD CONSTRAINT "review_schedule_cadence_chk" CHECK ("cadence_hours" > 0);
