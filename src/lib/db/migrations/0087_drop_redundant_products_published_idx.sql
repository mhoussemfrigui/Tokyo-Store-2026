-- 0087 — drop the redundant non-partial products(is_published, published_at)
-- index. `products_published_idx` (ASC, no WHERE) is fully superseded by
-- `products_published_recent_idx` (partial WHERE deleted_at IS NULL,
-- published_at DESC), which every real listing query matches — so the
-- non-partial one is pure write amplification (same class as the in_stock /
-- badge indexes dropped in 0084). The Drizzle schema drops the matching index
-- declaration in lockstep. IF EXISTS keeps re-apply idempotent.
DROP INDEX IF EXISTS "products_published_idx";
