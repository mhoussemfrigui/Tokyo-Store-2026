-- Editable chip-icon for the storefront listing "thumbs" strip (CategoryNavBar).
--
-- Each category / brand / collection can pick a curated lucide icon (`icon`
-- key) OR set a custom médiathèque image (`icon_media_id`, a soft link to a
-- media row — same pattern as hero_media_id / logo_media_id). Both nullable;
-- the storefront resolves them in priority order at render:
--   custom image (icon_media_id) > chosen icon key (icon) > per-type default.
-- No index needed — the columns are read alongside the row, never queried on.
ALTER TABLE "categories" ADD COLUMN IF NOT EXISTS "icon" text;--> statement-breakpoint
ALTER TABLE "categories" ADD COLUMN IF NOT EXISTS "icon_media_id" text;--> statement-breakpoint
ALTER TABLE "brands" ADD COLUMN IF NOT EXISTS "icon" text;--> statement-breakpoint
ALTER TABLE "brands" ADD COLUMN IF NOT EXISTS "icon_media_id" text;--> statement-breakpoint
ALTER TABLE "collections" ADD COLUMN IF NOT EXISTS "icon" text;--> statement-breakpoint
ALTER TABLE "collections" ADD COLUMN IF NOT EXISTS "icon_media_id" text;
