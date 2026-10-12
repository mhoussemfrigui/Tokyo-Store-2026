-- Brands: ERP + SEO parity with categories, and brand FAQs via a dedicated
-- brand_id column (rename-safe) instead of the legacy "brand:<slug>" scope. Idempotent.
--
-- 1) Brand ERP/SEO columns (mirror categories: external_ref + canonical_url +
--    noindex + og_image_media_id). New columns → all NULL/false, so the partial
--    indexes build trivially.
ALTER TABLE "brands" ADD COLUMN IF NOT EXISTS "external_ref" text;--> statement-breakpoint
ALTER TABLE "brands" ADD COLUMN IF NOT EXISTS "canonical_url" text;--> statement-breakpoint
ALTER TABLE "brands" ADD COLUMN IF NOT EXISTS "noindex" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "brands" ADD COLUMN IF NOT EXISTS "og_image_media_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "brands_external_ref_unique"
  ON "brands" ("external_ref") WHERE "external_ref" IS NOT NULL AND "deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "brands_og_image_media_id_idx"
  ON "brands" ("og_image_media_id") WHERE "og_image_media_id" IS NOT NULL;--> statement-breakpoint
-- 2) Brand FAQs: dedicated soft-FK column (immutable across slug renames),
--    matching product_id/category_id. Backfill any legacy "brand:<slug>" rows
--    (only clean rows with no other target, so the widened CHECK can't fail),
--    add the partial index, then widen the target-exclusivity CHECK to 3 dims
--    via num_nonnulls (at most one of product/category/brand is non-null).
ALTER TABLE "faqs" ADD COLUMN IF NOT EXISTS "brand_id" uuid;--> statement-breakpoint
UPDATE "faqs" f SET "brand_id" = b.id
  FROM "brands" b
  WHERE f."brand_id" IS NULL
    AND f."product_id" IS NULL
    AND f."category_id" IS NULL
    AND f."scope" LIKE 'brand:%'
    AND b."slug" = substring(f."scope" from 7)
    AND b."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "faqs_brand_idx"
  ON "faqs" ("brand_id") WHERE "brand_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "faqs" DROP CONSTRAINT IF EXISTS "faqs_scope_target_chk";--> statement-breakpoint
ALTER TABLE "faqs" ADD CONSTRAINT "faqs_scope_target_chk"
  CHECK (num_nonnulls("product_id", "category_id", "brand_id") <= 1);
