-- Media index hygiene.
--
-- (1) Drop two write-only indexes: NO query filters/orders by media.uploaded_by
-- or media.kind (uploaded_by is insert-only metadata; the resources-dashboard
-- `GROUP BY kind` over a 4-value enum won't use a btree). They only added
-- write cost on every upload/delete.
DROP INDEX IF EXISTS "media_uploader_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "media_kind_idx";--> statement-breakpoint
-- (2) Add a partial trigram index backing the MediaPicker / Médiathèque filename
-- search (`ilike(filename, '%q%')`, non-sargable) — the media table is the one
-- most likely to grow into thousands of rows, yet its search was the least
-- indexed (products/brands already have name trigram indexes). Partial on the
-- live set, matching the query's soft-delete filter. pg_trgm is enabled in the
-- baseline.
CREATE INDEX IF NOT EXISTS "media_filename_trgm"
  ON "media" USING gin ("filename" gin_trgm_ops)
  WHERE "deleted_at" IS NULL;
