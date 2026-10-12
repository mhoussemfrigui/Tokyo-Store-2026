-- Composite partial index for the admin stock-page filters (in_stock / low /
-- out_of_stock + the newest-first sort), so listStockPaged doesn't seq-scan +
-- sort the whole catalog on every render. Live rows only. Idempotent.
CREATE INDEX IF NOT EXISTS "products_stock_admin_idx"
  ON "products" ("in_stock", "is_preorder", "created_at" DESC)
  WHERE "deleted_at" IS NULL;
