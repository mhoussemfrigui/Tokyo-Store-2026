-- 0115 — Index the embedding-backfill candidate scan.
--
-- The semantic backfill's selectBackfillCandidates (embedding.service.ts) repeatedly
-- runs, per 100-row batch:
--   WHERE deleted_at IS NULL AND is_published = true
--     AND (embedding IS NULL OR embedding_input_hash IS NULL OR embedding_input_hash NOT LIKE '<model>|%')
--   ORDER BY (embedding IS NULL) DESC, updated_at DESC LIMIT N
-- The 0112 HNSW index is partial on the OPPOSITE predicate (embedding IS NOT NULL), so
-- the dominant "not yet embedded" branch had NO index → a full products seq scan + top-N
-- sort per batch (O(P^2 / batch) over an initial vectorization of a large catalog).
--
-- This partial btree covers exactly the un-embedded, embeddable rows in the reader's sort
-- order, so each batch is an index range scan instead of a full scan. It is TINY and
-- self-shrinking: once a product is embedded it leaves the partial set, so after a full
-- backfill the index holds only new/unpublished rows (near-empty). The stale-model
-- (NOT LIKE) branch can't be indexed and still needs a scan, but that only runs on a
-- deliberate model change, not the common initial/ongoing backfill. Additive + idempotent.

CREATE INDEX IF NOT EXISTS "products_embedding_backfill_idx"
  ON "products" ("updated_at" DESC)
  WHERE "embedding" IS NULL AND "deleted_at" IS NULL AND "is_published" = true;
