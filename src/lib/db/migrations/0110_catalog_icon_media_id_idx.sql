-- 0110 — brands/categories/collections.icon_media_id reverse-lookup indexes.
--
-- Additive-only. Migration 0105 added the custom chip-icon soft-link
-- `icon_media_id` (CategoryNavBar) on all three catalog taxonomy tables but,
-- per its own note, "no index needed — the columns are read alongside the row,
-- never queried on". That is no longer true: the média orphan check
-- (mediaQueries.listOrphans) and the per-média reference count
-- (countMediaReferences) now OR `icon_media_id` into the anti-join / count so a
-- chip-icon média is never mistaken for an orphan and hard-deleted. Without
-- these partial indexes each branch seq-scans its table.
--
-- Partial over NON-NULL rows (most rows use the lucide `icon` key, not a custom
-- image) so the index stays tiny and the reverse-lookup stays index-only —
-- exact parity with the image/hero/og_image soft-link indexes on these tables
-- (0093 / 0108). Plain CREATE INDEX (not CONCURRENTLY): drizzle's migrator wraps
-- each file in a transaction and these operator-curated tables are small, so the
-- brief build lock is fine.

CREATE INDEX IF NOT EXISTS "brands_icon_media_id_idx"
  ON "brands" ("icon_media_id")
  WHERE "icon_media_id" IS NOT NULL;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "categories_icon_media_id_idx"
  ON "categories" ("icon_media_id")
  WHERE "icon_media_id" IS NOT NULL;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "collections_icon_media_id_idx"
  ON "collections" ("icon_media_id")
  WHERE "icon_media_id" IS NOT NULL;
