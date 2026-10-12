-- 0062 — In-grid promo banner targeting + cadence.
--
-- The category_grid banners already inject between product rows on listing
-- pages, but they render GLOBALLY on every listing and at a fixed every-block
-- cadence. This adds per-banner targeting (show only on a category / brand /
-- filter) and a configurable cadence (appear after every N "Charger plus").
-- Purely additive; idempotent + safe to re-run.

ALTER TABLE "banners" ADD COLUMN IF NOT EXISTS "target_kind" text NOT NULL DEFAULT 'none';
DO $$ BEGIN
  ALTER TABLE "banners" ADD CONSTRAINT "banners_target_kind_chk"
    CHECK ("target_kind" IN ('none', 'category', 'brand', 'filter'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Slug of the target category/brand, or a filter attribute id. NULL when
-- target_kind = 'none' (global).
ALTER TABLE "banners" ADD COLUMN IF NOT EXISTS "target_ref" text;

-- Cadence: this banner appears after every N "Charger plus" blocks (default 2).
ALTER TABLE "banners" ADD COLUMN IF NOT EXISTS "after_load_more_count" integer NOT NULL DEFAULT 2;

CREATE INDEX IF NOT EXISTS "banners_target_idx" ON "banners" ("target_kind", "target_ref");
