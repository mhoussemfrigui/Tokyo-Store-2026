-- 0130 — Restrict auto-détourage to a product's MAIN image (opt-in).
--
-- Adds one boolean to the media_settings singleton. When ON (and product_white_bg
-- is on), upload-time background removal is skipped and only the product's MAIN
-- image (its first gallery image) is détoured — at product SAVE, via the
-- idempotent reprocess — so secondary/gallery shots keep their original backdrop.
-- Default FALSE preserves the current "détoure every product upload" behaviour.
--
-- NOT NULL + DEFAULT backfills the existing singleton row in place; no data
-- migration. IF NOT EXISTS keeps re-apply idempotent.

ALTER TABLE "media_settings"
  ADD COLUMN IF NOT EXISTS "product_white_bg_main_only" boolean DEFAULT false NOT NULL;
