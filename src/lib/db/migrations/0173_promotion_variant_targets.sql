-- 0173 — per-VARIANT promo targeting (GZ parity G6).
--
-- A promotion_scope_targets row of target_type='product' can now narrow to a single
-- product VARIANT: variant_id NULL = all variants (today's behaviour, byte-identical);
-- variant_id set = ONLY that variant. Soft link (no FK, like target_id). FAIL-CLOSED:
-- a variant-constrained target only discounts a line whose variant matches (the resolver
-- returns it in a separate rowsByVariant bucket, never the default all-variants rows).
-- No backfill — every existing target keeps variant_id NULL.
ALTER TABLE "promotion_scope_targets" ADD COLUMN IF NOT EXISTS "variant_id" uuid;--> statement-breakpoint

-- variant_id is meaningful only for a product target.
ALTER TABLE "promotion_scope_targets" DROP CONSTRAINT IF EXISTS "promotion_scope_targets_variant_type_chk";--> statement-breakpoint
ALTER TABLE "promotion_scope_targets" ADD CONSTRAINT "promotion_scope_targets_variant_type_chk"
  CHECK ("variant_id" IS NULL OR "target_type" = 'product');--> statement-breakpoint

-- Make the (promotion, type, target) uniqueness variant-aware. NULLS NOT DISTINCT
-- (PG15+; we run 16) so an « all variants » row (variant_id NULL) is still unique per
-- product — otherwise two NULL rows would slip past the default NULLS-DISTINCT rule.
DROP INDEX IF EXISTS "promotion_scope_targets_uniq";--> statement-breakpoint
CREATE UNIQUE INDEX "promotion_scope_targets_uniq"
  ON "promotion_scope_targets" ("promotion_id", "target_type", "target_id", "variant_id")
  NULLS NOT DISTINCT;--> statement-breakpoint

-- Reverse lookup: which targets constrain a given variant (small, sparse).
CREATE INDEX IF NOT EXISTS "promotion_scope_targets_variant_idx"
  ON "promotion_scope_targets" ("variant_id")
  WHERE "variant_id" IS NOT NULL;
