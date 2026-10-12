-- 0043 — Validate 0042's deferred constraints + drop two dead DB objects.
-- All idempotent. Audit-driven cleanup.

-- (1) VALIDATE the three constraints 0042 added NOT VALID (the 0040->0041 pattern).
-- All sit on objects created empty / a just-added uniformly-NULL column in 0042,
-- so validation is effectively free and lets the planner trust the FK/CHECK.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'promotion_targets_promotion_id_fkey' AND NOT convalidated) THEN
    ALTER TABLE "promotion_targets" VALIDATE CONSTRAINT "promotion_targets_promotion_id_fkey";
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'customer_segment_members_segment_id_fkey' AND NOT convalidated) THEN
    ALTER TABLE "customer_segment_members" VALIDATE CONSTRAINT "customer_segment_members_segment_id_fkey";
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'promotions_max_discount_chk' AND NOT convalidated) THEN
    ALTER TABLE "promotions" VALIDATE CONSTRAINT "promotions_max_discount_chk";
  END IF;
END $$;--> statement-breakpoint

-- (2) Drop the redundant single-column coin_tx_order_idx — every order_id lookup
-- also filters kind, so the (order_id, kind) composite covers it via its leftmost
-- prefix. Index drop = non-destructive, safe in the same deploy.
DROP INDEX IF EXISTS "coin_tx_order_idx";--> statement-breakpoint

-- (3) Drop the dead business_levels.slug column + its unique index — never written
-- (the level CRUD action never sets it) and never read. The current code stopped
-- selecting it (removed from the Drizzle schema) before this drop, so a fresh
-- chain + this migration converge; on a live rolling deploy, ship the schema
-- change first so no in-flight container still projects the column.
DROP INDEX IF EXISTS "business_levels_slug_unique";--> statement-breakpoint
ALTER TABLE "business_levels" DROP COLUMN IF EXISTS "slug";
