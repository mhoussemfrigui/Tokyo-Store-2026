-- 0113 — Align products_embedding_hnsw with the semantic reader's filter.
--
-- The vec KNN CTE (searchProducts) queries:
--   WHERE embedding IS NOT NULL AND deleted_at IS NULL AND is_published = true
--   ORDER BY embedding <=> $q LIMIT k
-- The 0112 index was partial only on `embedding IS NOT NULL`, so deleted_at/is_published
-- were applied as a POST-filter on the HNSW output: pgvector pulls ~ef_search candidates
-- from the graph FIRST, then drops the unpublished/soft-deleted ones — silently losing
-- recall whenever a cluster of nearest neighbours is a discontinued/unpublished product
-- line (the live save path can write embeddings for unpublished/draft rows). Folding the
-- two predicates INTO the index makes the filtering happen inside the graph, returns exactly
-- k eligible neighbours, and keeps draft/discontinued vectors out of the graph entirely.
--
-- The embedding value PERSISTS while a product is unpublished/soft-deleted (the column is
-- untouched), so re-publishing simply re-enters the row into the index — no re-embed needed.
-- Additive + idempotent; the column is all-NULL on a fresh DB so the rebuild is instant.

DROP INDEX IF EXISTS "products_embedding_hnsw";--> statement-breakpoint
SET max_parallel_maintenance_workers = 0;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "products_embedding_hnsw"
  ON "products" USING hnsw ("embedding" vector_cosine_ops)
  WHERE "embedding" IS NOT NULL AND "deleted_at" IS NULL AND "is_published" = true;--> statement-breakpoint
RESET max_parallel_maintenance_workers;--> statement-breakpoint
