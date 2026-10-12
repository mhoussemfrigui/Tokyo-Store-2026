-- 0170 — MULTI-target promotion scope (promotion_scope_targets).
--
-- Game Zone parity: one promotion can now target MANY products / categories /
-- brands at once (e.g. « −20% on these 5 watches AND the whole Cerise category »)
-- instead of exactly one (scope, scope_id). A promo with scope='targeted' carries
-- N rows here (scope_id NULL); the legacy single-scope rows (product/category/brand)
-- keep working unchanged AND are backfilled one row each below, so the resolver can
-- read a single, uniform source of truth (see promotion/queries.ts effectiveScopeTargets).
--
-- target_type: 'product' → products.id | 'category' → categories.id | 'brand' → brands.id.
-- include_descendants (categories only): when true a category target also covers
-- products in its SUBcategories (the established cascade). Ignored for product/brand.

CREATE TABLE IF NOT EXISTS "promotion_scope_targets" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "promotion_id" uuid NOT NULL,
  "target_type" text NOT NULL,
  "target_id" uuid NOT NULL,
  "include_descendants" boolean NOT NULL DEFAULT true,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "promotion_scope_targets_type_chk"
    CHECK ("target_type" IN ('product', 'category', 'brand')),
  CONSTRAINT "promotion_scope_targets_promotion_id_fk"
    FOREIGN KEY ("promotion_id") REFERENCES "promotions"("id") ON DELETE CASCADE
);--> statement-breakpoint

-- One row per (promotion, type, target) — de-dupes a double-add of the same entity.
CREATE UNIQUE INDEX IF NOT EXISTS "promotion_scope_targets_uniq"
  ON "promotion_scope_targets" ("promotion_id", "target_type", "target_id");--> statement-breakpoint
-- Reverse lookup: which promotions target this entity (delete-guard + resolver bucketing).
CREATE INDEX IF NOT EXISTS "promotion_scope_targets_lookup_idx"
  ON "promotion_scope_targets" ("target_type", "target_id");--> statement-breakpoint

-- Relax the scope/scope_id shape CHECK so 'targeted' (like 'cart') carries NO
-- scope_id, while product/category/brand still MUST. Phrased in terms of the
-- scopes that REQUIRE a scope_id (product/category/brand) rather than naming
-- 'targeted': the drizzle migrator applies all pending migrations in ONE
-- transaction, and a newly-added enum value (0169) cannot be REFERENCED in the
-- same transaction (PG 55P04) — but the OLD values can. Logically identical:
-- cart / targeted fall in the "NOT IN (…)" branch → scope_id must be NULL.
ALTER TABLE "promotions" DROP CONSTRAINT IF EXISTS "promotions_scope_id_match_chk";--> statement-breakpoint
ALTER TABLE "promotions" ADD CONSTRAINT "promotions_scope_id_match_chk" CHECK (
  ("scope" IN ('product', 'category', 'brand') AND "scope_id" IS NOT NULL)
  OR ("scope" NOT IN ('product', 'category', 'brand') AND "scope_id" IS NULL)
);--> statement-breakpoint

-- Backfill: every existing single-scope promo (product/category/brand) gets ONE
-- scope-target row mirroring its (scope, scope_id), include_descendants=true (the
-- category cascade the resolver already applied). Idempotent via ON CONFLICT.
-- cart / targeted promos have no scope_id → nothing to backfill.
INSERT INTO "promotion_scope_targets" ("promotion_id", "target_type", "target_id", "include_descendants")
SELECT "id", "scope"::text, "scope_id", true
  FROM "promotions"
 WHERE "scope" IN ('product', 'category', 'brand') AND "scope_id" IS NOT NULL
ON CONFLICT ("promotion_id", "target_type", "target_id") DO NOTHING;
