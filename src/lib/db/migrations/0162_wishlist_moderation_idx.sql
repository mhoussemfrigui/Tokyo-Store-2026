-- 0162 — index for the Favoris public-profile moderation board.
--
-- The moderation list + its pager count filter on (is_public OR public_locked) and
-- order by created_at DESC, id DESC (src/modules/wishlist/service.ts
-- publicProfileFilter / listPublicProfiles / publicProfileCount). No existing index
-- covered that predicate, so both the board and its count seq-scanned the WHOLE
-- wishlists table on every load. This partial index scans only the (small)
-- moderatable subset; a created_at btree serves the DESC pager via a backward scan.
CREATE INDEX IF NOT EXISTS "wishlists_moderatable_idx"
  ON "wishlists" ("created_at")
  WHERE ("is_public" OR "public_locked");
