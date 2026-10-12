-- Categories: free soft-deleted root slugs + index the OG image soft-link. Idempotent.
--
-- 1) categories_root_slug_unique currently spans ALL roots incl. soft-deleted
--    ones, so archiving a root (soft-delete) keeps its slug reserved — which
--    blocks a new root with that slug AND can abort a child-promotion-to-root
--    during delete with an unactionable conflict (the colliding root is hidden
--    from the admin tree). checkSlugAvailability + categories_external_ref_unique
--    already filter deleted_at; align the root-slug index the same way. The new
--    predicate covers a SUBSET of the old one (live roots), which were already
--    unique, so the recreate cannot fail on existing data. The hard-delete
--    re-seed path removes rows outright (no tombstones), so it is unaffected.
DROP INDEX IF EXISTS "categories_root_slug_unique";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "categories_root_slug_unique"
  ON "categories" ("slug") WHERE "parent_id" IS NULL AND "deleted_at" IS NULL;--> statement-breakpoint
-- 2) Index categories.og_image_media_id (added in 0016 without one), matching
--    categories_hero_media_id_idx and products/pages og_image indexes, so the
--    media orphan reverse-lookup (listOrphans) stays index-only.
CREATE INDEX IF NOT EXISTS "categories_og_image_media_id_idx"
  ON "categories" ("og_image_media_id") WHERE "og_image_media_id" IS NOT NULL;
