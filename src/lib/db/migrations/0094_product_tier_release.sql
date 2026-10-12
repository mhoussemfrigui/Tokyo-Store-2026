-- "Drip Content & Exclusivité" — per-product, per-tier timed visibility.
-- Extends the Section-3 fidelity early-access: a product can be released to
-- loyalty tiers progressively (drip) and/or locked to a tier forever
-- (exclusivity), INDEPENDENTLY across two ladders:
--   ladder='coin'     → consumer COIN levels (coin_levels, ranked by threshold_coins ASC)
--   ladder='business' → B2B BUSINESS levels (business_levels, ranked by display_order ASC;
--                       last in admin order = top/most-exclusive)
-- Each row pins one (level_id, dwell_days) step on a ladder. dwell_days NULL =
-- ∞/forever (the drip stops there = exclusive floor). level_id is a SOFT link
-- (references coin_levels.id OR business_levels.id depending on ladder — NO
-- cross-ladder FK). Idempotent.
CREATE TABLE IF NOT EXISTS "product_tier_release" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
  "product_id" uuid NOT NULL,
  "ladder" text NOT NULL,
  "level_id" uuid NOT NULL,
  "dwell_days" integer,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
-- ladder is constrained to the two known ladders.
ALTER TABLE "product_tier_release" DROP CONSTRAINT IF EXISTS "product_tier_release_ladder_check";--> statement-breakpoint
ALTER TABLE "product_tier_release" ADD CONSTRAINT "product_tier_release_ladder_check"
  CHECK ("ladder" IN ('coin', 'business'));--> statement-breakpoint
-- dwell_days, when set, is a non-negative number of days (NULL = ∞/forever).
ALTER TABLE "product_tier_release" DROP CONSTRAINT IF EXISTS "product_tier_release_dwell_check";--> statement-breakpoint
ALTER TABLE "product_tier_release" ADD CONSTRAINT "product_tier_release_dwell_check"
  CHECK ("dwell_days" IS NULL OR "dwell_days" >= 0);--> statement-breakpoint
-- NB: index prefix is "ptr_" — pc_/pcomp_/pcol_ namespaces are taken
-- (product_categories / product_complementary / product_collections). Postgres
-- index names are schema-global, so a colliding prefix would silently no-op under
-- CREATE INDEX IF NOT EXISTS, leaving the index uncreated.
CREATE UNIQUE INDEX IF NOT EXISTS "ptr_product_ladder_level_unique"
  ON "product_tier_release" ("product_id","ladder","level_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ptr_product_idx" ON "product_tier_release" ("product_id");--> statement-breakpoint
-- FK: deleting a product drops its whole release schedule.
ALTER TABLE "product_tier_release" DROP CONSTRAINT IF EXISTS "product_tier_release_product_id_fkey";--> statement-breakpoint
ALTER TABLE "product_tier_release" ADD CONSTRAINT "product_tier_release_product_id_fkey"
  FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE;--> statement-breakpoint
-- Drip start anchor for the schedule (NULL = fall back to published_at). The save
-- action sets it to now() when a schedule is first created so an old product
-- starts dripping from now, not its original publish date.
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "drip_start_at" timestamp with time zone;
