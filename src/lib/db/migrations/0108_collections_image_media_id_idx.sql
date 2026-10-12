-- 0108 — collections.image_media_id reverse-lookup index.
--
-- Additive-only. Completes the media soft-link reverse-lookup index set: the
-- media orphan check (mediaQueries.listOrphans) and the per-media reference
-- count (countMediaReferences) both OR collections.image_media_id with
-- collections.og_image_media_id. og_image was indexed (0093), image_media_id
-- was not — so the OR's image_media_id branch seq-scanned `collections`.
--
-- Every other media soft-link column across the schema (products.video_poster/
-- og_image, product_variants.image, brands.logo/hero/og_image, categories.hero/
-- og_image, collections.og_image, banners, pages, hero_sections, …) already has
-- this exact partial index. This is the one the convention skipped.
--
-- Partial over NON-NULL rows (most collections have no hero set) so the index
-- stays small + the anti-join / count stays index-only. Plain CREATE INDEX (not
-- CONCURRENTLY): drizzle's migrator wraps each file in a transaction and the
-- table is operator-curated + small, so the brief build lock is fine.

CREATE INDEX IF NOT EXISTS "collections_image_media_id_idx"
  ON "collections" ("image_media_id")
  WHERE "image_media_id" IS NOT NULL;
