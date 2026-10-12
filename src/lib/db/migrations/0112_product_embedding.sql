-- 0112 — Semantic search foundation: product embeddings (pgvector).
--
-- Adds the `vector` extension, a NULLABLE products.embedding vector(1536) column
-- (OpenAI text-embedding-3-small dimension), an HNSW cosine index over the embedded
-- rows, and embedding_input_hash to gate re-embedding (re-embed only when the source
-- text actually changes). Fully ADDITIVE + IDEMPOTENT: nothing touches existing columns
-- or data, and the column stays NULL until the embedding pipeline / backfill fills it,
-- so search behaviour is UNCHANGED until semantic search is enabled (search.semantic_enabled).
--
-- REQUIRES pgvector on the server image (docker/pgvector/Dockerfile in dev; the Coolify
-- Postgres database image must be an equivalent pg16 + pgvector build BEFORE this deploys,
-- else CREATE EXTENSION fails). Same-Alpine-base swap is data-safe (no reindex).

CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint

ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "embedding" vector(1536);--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "embedding_input_hash" text;--> statement-breakpoint

-- HNSW cosine index over EMBEDDED rows only (partial — an all-NULL column indexes
-- nothing; the pipeline fills it incrementally). Cosine ops back the search score's
-- (1 - (embedding <=> query)) semantic-similarity term.
--
-- A PARALLEL index build coordinates workers via a shared-memory (/dev/shm) segment
-- sized from maintenance_work_mem, which overflows a container's default 64MB /dev/shm
-- on a large base table (« could not resize shared memory segment »). The column is
-- all-NULL at migration time, so a SERIAL build is instant — disable parallel
-- maintenance workers for it so the migration is portable regardless of /dev/shm size.
SET max_parallel_maintenance_workers = 0;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "products_embedding_hnsw"
  ON "products" USING hnsw ("embedding" vector_cosine_ops)
  WHERE "embedding" IS NOT NULL;--> statement-breakpoint
RESET max_parallel_maintenance_workers;--> statement-breakpoint
