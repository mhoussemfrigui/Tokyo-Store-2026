-- Categories: ERP linkage + SEO parity with products. Idempotent.
--
-- external_ref     — stable opaque code from an EXTERNAL system (ERP / PIM /
--                    marketplace) for linking & syncing a category BY REFERENCE
--                    over the API. Unique among LIVE categories (partial,
--                    mirrors products_external_ref_unique). New column → all
--                    NULL, so the index builds trivially (no dedupe needed).
-- canonical_url    — per-category canonical override (folds duplicate / faceted
--                    URLs onto one master), mirrors products.canonical_url.
-- noindex          — keep a still-active category out of search results without
--                    deactivating it, mirrors products.noindex.
-- og_image_media_id — per-category social/OG image (soft link to media),
--                    mirrors products.og_image_media_id.
ALTER TABLE "categories" ADD COLUMN IF NOT EXISTS "external_ref" text;--> statement-breakpoint
ALTER TABLE "categories" ADD COLUMN IF NOT EXISTS "canonical_url" text;--> statement-breakpoint
ALTER TABLE "categories" ADD COLUMN IF NOT EXISTS "noindex" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "categories" ADD COLUMN IF NOT EXISTS "og_image_media_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "categories_external_ref_unique"
  ON "categories" ("external_ref") WHERE "external_ref" IS NOT NULL AND "deleted_at" IS NULL;
