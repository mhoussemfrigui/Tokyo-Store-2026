-- 0063 — Index product_reviews(created_at DESC).
--
-- The admin moderation list (reviewService.listForAdmin) and the per-user
-- review list both ORDER BY created_at DESC, often with an optional
-- status/source filter. The existing indexes cover (product_id, status),
-- (user_id) and (source) but none orders by created_at, so every admin page
-- load sorts the matched rows from scratch. Purely additive; idempotent.

CREATE INDEX IF NOT EXISTS "product_reviews_created_idx"
  ON "product_reviews" ("created_at" DESC);
