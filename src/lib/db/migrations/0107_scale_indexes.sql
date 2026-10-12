-- 0107 — Scale-readiness indexes (catalog).
--
-- Additive-only. Three indexes that keep catalog reads sub-linear as the
-- product/collection tables grow toward 100k–1M rows. No data change, no drops.
-- Plain CREATE INDEX (not CONCURRENTLY): drizzle's migrator runs each file in a
-- transaction, and the tables are small today, so a brief build lock is fine.

-- 1) Admin product + stock lists ORDER BY (created_at DESC, id DESC) with
--    LIMIT/OFFSET (productService.listAdminPaged / listStockPaged). The baseline
--    only has products_created_at_idx (created_at ASC, single column, no id
--    tiebreaker), so the id-DESC tiebreaker forced a sort + heap fetch on deep
--    pages. A composite matching the sort direction + a tiebreaker serves the
--    scan index-only. Partial over the live set (every list filters
--    deleted_at IS NULL).
CREATE INDEX IF NOT EXISTS "products_created_id_desc_idx"
  ON "products" ("created_at" DESC, "id" DESC)
  WHERE "deleted_at" IS NULL;

-- 2) Admin product/stock search ILIKEs name OR sku with a leading wildcard.
--    name is already trigram-indexed (products_name_trgm, baseline), but sku had
--    only the equality-only partial UNIQUE btree, so the `sku ILIKE '%term%'`
--    branch seq-scanned the whole products table. A trigram GIN lets the OR
--    BitmapOr both GINs instead. (pg_trgm is enabled in the baseline.)
CREATE INDEX IF NOT EXISTS "products_sku_trgm"
  ON "products" USING gin ("sku" gin_trgm_ops)
  WHERE "deleted_at" IS NULL;

-- 3) Admin collections search ILIKEs collections.name with a leading wildcard —
--    collections had no trigram index (unlike brands_name_trgm /
--    categories_name_trgm). Add one for parity so collection search stays
--    index-backed if the catalog of merchandising collections grows.
CREATE INDEX IF NOT EXISTS "collections_name_trgm"
  ON "collections" USING gin ("name" gin_trgm_ops)
  WHERE "deleted_at" IS NULL;
