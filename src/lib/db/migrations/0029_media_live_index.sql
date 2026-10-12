-- Media live-set index hygiene.
--
-- Replace the full single-column media_created_at_idx with a PARTIAL COMPOSITE
-- index over the live set. Every query that orders or counts by media.created_at
-- already filters `deleted_at IS NULL` (list keyset pagination, the Médiathèque
-- live count(), and listOrphans), so:
--   (1) the live count() becomes index-only instead of a full seq scan, and
--   (2) the keyset scan (ORDER BY created_at DESC, id DESC) is fully index-ordered
--       with no in-group sort at same-timestamp seams.
-- The full index is now redundant (no query touches created_at over deleted rows).
DROP INDEX IF EXISTS "media_created_at_idx";--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "media_live_idx"
  ON "media" ("created_at" DESC, "id" DESC)
  WHERE "deleted_at" IS NULL;
