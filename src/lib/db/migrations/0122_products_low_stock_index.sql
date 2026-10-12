-- 0122 — Low-stock dashboard index.
--
-- listLowStockProducts (admin dashboard, runs on every /admin load) executes
--   WHERE is_published = true AND deleted_at IS NULL AND stock_qty IS NOT NULL
--         AND stock_qty <= N
--   ORDER BY stock_qty ASC LIMIT <=20
-- No index leads on products.stock_qty, so Postgres reads every live+published
-- row, evaluates stock_qty and sorts the survivors — the ORDER BY blocks any
-- early stop from the LIMIT, so it degrades to a full published-set scan + sort
-- at scale.
--
-- A PARTIAL index on stock_qty over only the tracked-stock published subset
-- serves the WHERE filter and the `ORDER BY stock_qty ASC` from the index and
-- early-stops via LIMIT (an index range scan + a heap fetch for the <=20
-- survivors), and stays tiny by excluding the untracked (NULL) / unpublished majority.
--
-- Additive-only + idempotent.

CREATE INDEX IF NOT EXISTS "products_low_stock_idx"
  ON "products" ("stock_qty")
  WHERE "deleted_at" IS NULL AND "is_published" = true AND "stock_qty" IS NOT NULL;
