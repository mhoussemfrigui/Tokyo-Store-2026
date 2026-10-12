-- Collections editorial + FAQ parity with categories / brands.
--
-- 1) Storytelling block on collections (eyebrow / title / body + value-prop
--    cards), mirroring the columns categories + brands already carry. All
--    nullable so a blank field simply doesn't render the block.
ALTER TABLE "collections" ADD COLUMN IF NOT EXISTS "editorial_eyebrow" text;--> statement-breakpoint
ALTER TABLE "collections" ADD COLUMN IF NOT EXISTS "editorial_title" text;--> statement-breakpoint
ALTER TABLE "collections" ADD COLUMN IF NOT EXISTS "editorial_body" text;--> statement-breakpoint
ALTER TABLE "collections" ADD COLUMN IF NOT EXISTS "value_props" jsonb;--> statement-breakpoint

-- 2) Per-collection FAQ — soft FK + partial index, twin of brand_id (0018).
ALTER TABLE "faqs" ADD COLUMN IF NOT EXISTS "collection_id" uuid;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "faqs_collection_idx"
  ON "faqs" ("collection_id") WHERE "collection_id" IS NOT NULL;--> statement-breakpoint

-- 3) Widen the single-target invariant (0018 widened it for brand_id) so AT MOST
--    one of product/category/brand/collection is set — a collection FAQ is never
--    also a product/category/brand FAQ.
ALTER TABLE "faqs" DROP CONSTRAINT IF EXISTS "faqs_scope_target_chk";--> statement-breakpoint
ALTER TABLE "faqs" ADD CONSTRAINT "faqs_scope_target_chk"
  CHECK (num_nonnulls("product_id", "category_id", "brand_id", "collection_id") <= 1);
