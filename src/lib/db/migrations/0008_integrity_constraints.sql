-- Produits final-audit DB hardening. All idempotent (IF EXISTS / IF NOT EXISTS
-- / drop-then-add for CHECKs / partial unique on the live set).

-- 1. Primary-category integrity: at most ONE is_primary row per product.
--    Imports could leave several (non-deterministic breadcrumb/URL). Dedupe any
--    existing multi-primary (keep the physically-first), then enforce — mirrors
--    product_variants_one_default_per_product.
UPDATE "product_categories" pc SET "is_primary" = false
  WHERE "is_primary" = true
    AND "ctid" <> (
      SELECT min(pc2."ctid") FROM "product_categories" pc2
      WHERE pc2."product_id" = pc."product_id" AND pc2."is_primary" = true
    );--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "product_categories_one_primary_per_product"
  ON "product_categories" ("product_id") WHERE "is_primary";--> statement-breakpoint

-- 2. SKU / GTIN uniqueness. Partial (these are nullable) over the live set, so
--    a blank/absent code is unconstrained and a tombstone frees its code.
--    Real catalog data can carry accidental duplicates (e.g. two products tagged
--    with the same barcode on import). A partial UNIQUE index FAILS to build on
--    such data, and because migrations run in order in one transaction, that one
--    failure blocks the ENTIRE chain and crash-loops the app on every deploy.
--    So NEUTRALISE duplicates first: among live (non-deleted) rows sharing a
--    code, keep the physically-first (min ctid) and NULL the code on the rest —
--    the value is recoverable (an admin re-enters it) but the deploy is no longer
--    wedged. Mirrors the primary-category dedupe above. Each dedupe is a no-op
--    once its index exists, so re-running stays idempotent.
UPDATE "products" p SET "sku" = NULL
  WHERE "sku" IS NOT NULL AND "deleted_at" IS NULL
    AND "ctid" <> (
      SELECT min(p2."ctid") FROM "products" p2
      WHERE p2."sku" = p."sku" AND p2."deleted_at" IS NULL
    );--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "products_sku_unique"
  ON "products" ("sku") WHERE "sku" IS NOT NULL AND "deleted_at" IS NULL;--> statement-breakpoint
UPDATE "products" p SET "gtin" = NULL
  WHERE "gtin" IS NOT NULL AND "deleted_at" IS NULL
    AND "ctid" <> (
      SELECT min(p2."ctid") FROM "products" p2
      WHERE p2."gtin" = p."gtin" AND p2."deleted_at" IS NULL
    );--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "products_gtin_unique"
  ON "products" ("gtin") WHERE "gtin" IS NOT NULL AND "deleted_at" IS NULL;--> statement-breakpoint
UPDATE "product_variants" v SET "sku" = NULL
  WHERE "sku" IS NOT NULL AND "deleted_at" IS NULL
    AND "ctid" <> (
      SELECT min(v2."ctid") FROM "product_variants" v2
      WHERE v2."sku" = v."sku" AND v2."deleted_at" IS NULL
    );--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "product_variants_sku_unique"
  ON "product_variants" ("sku") WHERE "sku" IS NOT NULL AND "deleted_at" IS NULL;--> statement-breakpoint
UPDATE "product_variants" v SET "gtin" = NULL
  WHERE "gtin" IS NOT NULL AND "deleted_at" IS NULL
    AND "ctid" <> (
      SELECT min(v2."ctid") FROM "product_variants" v2
      WHERE v2."gtin" = v."gtin" AND v2."deleted_at" IS NULL
    );--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "product_variants_gtin_unique"
  ON "product_variants" ("gtin") WHERE "gtin" IS NOT NULL AND "deleted_at" IS NULL;--> statement-breakpoint

-- 3. Aggregate guards on the review denormalizations (recomputed from reviews).
--    Clamp any out-of-range cached values first so ADD CONSTRAINT can't fail on
--    dirty data and re-wedge the chain — these are caches that reviews recompute.
UPDATE "products" SET "rating" = LEAST(GREATEST("rating", 0), 5)
  WHERE "rating" < 0 OR "rating" > 5;--> statement-breakpoint
UPDATE "products" SET "reviews_count" = 0 WHERE "reviews_count" < 0;--> statement-breakpoint
ALTER TABLE "products" DROP CONSTRAINT IF EXISTS "products_rating_range";--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_rating_range" CHECK ("rating" >= 0 AND "rating" <= 5);--> statement-breakpoint
ALTER TABLE "products" DROP CONSTRAINT IF EXISTS "products_reviews_count_nonneg";--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_reviews_count_nonneg" CHECK ("reviews_count" >= 0);
-- (A user-leading index on promotion_redemptions was considered but skipped:
--  promotion_redemptions_user_idx already covers (promotion_id, user_id) for the
--  quota check, and a user-only index is write-cost the audit flagged as
--  scale-dependent — add it only if per-user redemption reporting grows.)
