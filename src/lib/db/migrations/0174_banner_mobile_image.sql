-- 0174 — banners.image_mobile_media_id (art-directed mobile visual).
--
-- A banner can now carry a SECOND, portrait-cropped image shown on phones while
-- the landscape `image_media_id` stays the desktop visual. The home-hero carousel
-- (and any banner renderer) swaps to it under the mobile breakpoint via <picture>
-- art direction. Additive-only, nullable — every existing banner keeps a single
-- image (mobile falls back to the desktop crop), so the storefront is byte-identical
-- until an operator sets a mobile visual.
ALTER TABLE "banners" ADD COLUMN IF NOT EXISTS "image_mobile_media_id" text;--> statement-breakpoint

-- Reverse-lookup partial index — the media orphan sweep (mediaQueries.listOrphans),
-- the reference check and the per-media reference count all OR this column with
-- image_media_id. Without the index that branch seq-scans `banners`. Partial over
-- NON-NULL rows (most banners have no mobile crop) so it stays index-only, matching
-- the existing banners_image_media_id_idx.
CREATE INDEX IF NOT EXISTS "banners_image_mobile_media_id_idx"
  ON "banners" ("image_mobile_media_id")
  WHERE "image_mobile_media_id" IS NOT NULL;
