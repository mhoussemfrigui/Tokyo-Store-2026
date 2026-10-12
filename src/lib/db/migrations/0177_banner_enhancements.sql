-- 0177 — banner enhancements (Contenu & Design → Bannières).
--
-- Additive-only, nullable/defaulted — every existing banner keeps its behaviour:
--   * video_url         — optional HOSTED video URL for the home hero (plays muted/looped
--                         with image_media_id as the poster/fallback). A plain URL, NOT a
--                         média id: the médiathèque pipeline is image-only, so the video is
--                         hosted on an external CDN and referenced by URL (sanitised on read).
--   * show_text         — home hero: false = a pure image/video link (no text overlay).
--   * buttons           — JSON array of editable CTAs [{label, href, variant}] (supersedes
--                         the legacy cta_* / secondary_cta_* columns, which are migrated into
--                         it on read; NULL = use the legacy columns).
--   * grid_position     — category_grid placement: 'top' (above the listing) | 'after_load_more'
--                         (at the first block boundary only) | 'after_rows' (every N blocks, the
--                         legacy cadence). N stays `after_load_more_count`.
--   * strip_tone        — header_strip background tone (olive default | dark | gold | burgundy).
--   * strip_icon        — header_strip optional leading emoji/short glyph.
--   * show_countdown    — header_strip: show a live countdown to `end_at` for urgency.
ALTER TABLE "banners" ADD COLUMN IF NOT EXISTS "video_url" text;--> statement-breakpoint
ALTER TABLE "banners" ADD COLUMN IF NOT EXISTS "show_text" boolean NOT NULL DEFAULT true;--> statement-breakpoint
ALTER TABLE "banners" ADD COLUMN IF NOT EXISTS "buttons" text;--> statement-breakpoint
ALTER TABLE "banners" ADD COLUMN IF NOT EXISTS "grid_position" text NOT NULL DEFAULT 'after_rows';--> statement-breakpoint
ALTER TABLE "banners" ADD COLUMN IF NOT EXISTS "strip_tone" text NOT NULL DEFAULT 'olive';--> statement-breakpoint
ALTER TABLE "banners" ADD COLUMN IF NOT EXISTS "strip_icon" text;--> statement-breakpoint
ALTER TABLE "banners" ADD COLUMN IF NOT EXISTS "show_countdown" boolean NOT NULL DEFAULT false;--> statement-breakpoint

-- CHECK constraints over the literal value sets (same pattern as banners_target_kind_chk,
-- kept out of the frozen drizzle snapshot). Idempotent via a duplicate_object guard.
DO $$ BEGIN
  ALTER TABLE "banners" ADD CONSTRAINT "banners_grid_position_chk"
    CHECK ("grid_position" IN ('top', 'after_load_more', 'after_rows'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "banners" ADD CONSTRAINT "banners_strip_tone_chk"
    CHECK ("strip_tone" IN ('olive', 'dark', 'gold', 'burgundy'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

-- Preserve the previous "the FIRST matched category_grid banner shows above the grid"
-- behaviour. The old client pinned gridBanners[0] PER LISTING, where gridBanners was the
-- targeting-filtered set — so the pinned banner differed per targeting scope. Promote the
-- lowest-display_order banner of EACH (target_kind, target_ref) group to `top` (DISTINCT ON
-- treats equal/NULL refs as one group, so all global 'none' banners share one pin), rather
-- than a single global row — otherwise a targeted banner on a short listing (that never
-- reaches a between-row boundary) would silently stop showing. The rest stay `after_rows`.
UPDATE "banners" SET "grid_position" = 'top'
  WHERE "id" IN (
    SELECT DISTINCT ON ("target_kind", "target_ref") "id"
    FROM "banners"
    WHERE "placement" = 'category_grid' AND "deleted_at" IS NULL
    ORDER BY "target_kind", "target_ref", "display_order" ASC, "created_at" ASC
  );
-- NB: video_url is a plain external URL (not a média id), so it needs NO media
-- orphan-tracking seam and NO reverse-lookup index — unlike image_media_id /
-- image_mobile_media_id, which do.
