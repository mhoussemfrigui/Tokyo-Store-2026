-- 0179 — trust_badges cleanup: retire the dead `preorder` visibility, add a
-- `kind` CHECK for parity with `visibility`, and consolidate the two unused
-- single-column indexes into the one composite that matches listActive().
--
-- WHY:
--  * `preorder` visibility is dead at runtime — preorders were removed store-wide
--    and the only visual consumer hardwires showPreorder=false, so a preorder
--    badge can never display. Convert any legacy row to `in_stock` (the closest
--    live meaning) BEFORE tightening the CHECK, then drop `preorder` from the
--    allowed set. New rows were already blocked by the workflow enum.
--  * `kind` had no DB CHECK while `visibility` did (asymmetric). The workflow is
--    the only writer and already constrains it, but a CHECK is cheap defense and
--    documents the valid set at the schema level.
--  * The table holds a handful of rows, so two single-column indexes (display_order,
--    is_active) are never chosen by the planner and are pure write overhead. One
--    composite (is_active, display_order) matches listActive's WHERE+ORDER BY, so
--    it is the only index worth keeping (mirrors migration 0178's banner prune).

-- 1. Convert legacy preorder rows to the closest LIVE value, then tighten the CHECK.
UPDATE "trust_badges" SET "visibility" = 'in_stock' WHERE "visibility" = 'preorder';--> statement-breakpoint
ALTER TABLE "trust_badges" DROP CONSTRAINT IF EXISTS "trust_badges_visibility_chk";--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "trust_badges" ADD CONSTRAINT "trust_badges_visibility_chk"
    CHECK ("visibility" IN ('always','in_stock'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

-- 2. kind CHECK — parity with visibility (NULL = free-form custom badge).
DO $$ BEGIN
  ALTER TABLE "trust_badges" ADD CONSTRAINT "trust_badges_kind_chk"
    CHECK ("kind" IS NULL OR "kind" IN ('security','delivery','returns','warranty'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

-- 3. Consolidate indexes: drop the two unused singles, keep one composite that
--    matches listActive (WHERE is_active = true ORDER BY display_order).
DROP INDEX IF EXISTS "trust_badges_order_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "trust_badges_active_idx";--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "trust_badges_active_order_idx"
  ON "trust_badges" ("is_active","display_order");
