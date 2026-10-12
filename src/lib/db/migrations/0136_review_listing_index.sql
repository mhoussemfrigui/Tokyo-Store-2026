-- 0136 — Covering index for the PDP approved-review listing (perf, non-breaking).
--
-- listApproved() filters WHERE product_id = ? AND status = 'approved' then
-- ORDER BY created_at DESC — a hot PUBLIC path (every product page). The old
-- (product_id, status) index answered the filter but left Postgres to SORT the
-- matches by created_at. Replace it with (product_id, status, created_at DESC)
-- so the same lookup is ALSO index-ordered (no sort). The 3-column index still
-- serves the (product_id) / (product_id, status) prefix lookups the 2-column one
-- did, so dropping the old one leaves no capability gap and avoids a redundant
-- index's write cost.

DROP INDEX IF EXISTS "product_reviews_product_status_idx";
CREATE INDEX IF NOT EXISTS "product_reviews_product_status_created_idx"
  ON "product_reviews" ("product_id", "status", "created_at" DESC);
