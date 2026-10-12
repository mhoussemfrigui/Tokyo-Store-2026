-- Add `external_ref` to products: a stable, opaque code from an EXTERNAL system
-- (ERP / PIM / marketplace) for linking & syncing a product BY REFERENCE over
-- the API, kept distinct from the merchandising SKU. Unique among live products
-- (partial, mirrors products_sku_unique). New column → all NULL, so the index
-- builds trivially (no dedupe needed). Idempotent.
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "external_ref" text;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "products_external_ref_unique"
  ON "products" ("external_ref") WHERE "external_ref" IS NOT NULL AND "deleted_at" IS NULL;
