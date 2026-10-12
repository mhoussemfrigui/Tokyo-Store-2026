-- 0171 — scheduled promotion announcement (GZ parity G4).
--
-- Today a promotion can be announced by email only at CREATION, immediately (the
-- « Annoncer par email » checkbox → a promotion.announce_requested event). G4 adds
-- SCHEDULING: pick a future instant and a cron sweep fires the announcement when due.
--   announce_at   — the scheduled instant (store-local wall-clock, parsed +01:00);
--                   NULL = no scheduled announce. Set/cleared from the promo form.
--   announced_at  — when the announcement was fired (idempotency claim + display);
--                   NULL = never announced. The sweep claims a due row race-safely
--                   (UPDATE … SET announced_at = now() WHERE announced_at IS NULL) BEFORE
--                   the blast, so overlapping ticks / a manual run can't double-fire.
-- No backfill: both NULL for existing rows = « no scheduled announce, never announced ».
ALTER TABLE "promotions" ADD COLUMN IF NOT EXISTS "announce_at" timestamptz;--> statement-breakpoint
ALTER TABLE "promotions" ADD COLUMN IF NOT EXISTS "announced_at" timestamptz;--> statement-breakpoint

-- Partial index for the sweep scan (only unsent, live rows are ever candidates).
CREATE INDEX IF NOT EXISTS "promotions_announce_due_idx"
  ON "promotions" ("announce_at")
  WHERE "announced_at" IS NULL AND "deleted_at" IS NULL;
