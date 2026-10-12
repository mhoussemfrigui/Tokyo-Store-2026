-- 0126 — Repair the low-stock index predicate + prune redundant leading-column indexes.
--
-- 1) products_low_stock_idx (created in 0122) is UNUSABLE by the very query it
--    was built to serve. Its predicate is
--        deleted_at IS NULL AND is_published = true AND stock_qty IS NOT NULL
--    but listLowStockProducts / countStockProducts (product/queries.ts) filter
--        deleted_at IS NULL AND in_stock = true AND stock_qty BETWEEN 1 AND N
--    over EVERY live product — published or not (the dashboard « Stock faible »
--    card mirrors the stock page, which lists drafts too). Because the query
--    carries no is_published predicate, the planner can't prove the partial
--    index covers the result set, so it's ignored and the query falls back to a
--    full live-set scan + sort — exactly what 0122 meant to remove.
--
--    Recreate it with a predicate the query IMPLIES:
--        deleted_at IS NULL AND in_stock = true AND stock_qty IS NOT NULL
--    (`stock_qty BETWEEN 1 AND N` ⟹ stock_qty IS NOT NULL; in_stock = true and
--    deleted_at IS NULL are explicit). Now the `ORDER BY stock_qty ASC` runs off
--    the index with an early-stop via LIMIT, and the index stays small (only
--    live, in-stock, tracked rows). DROP+CREATE under the same name; the leaf
--    column (stock_qty) is unchanged.
--
-- 2) Drop three single-column indexes that are leading-column prefixes of a
--    composite PK/index already present — pure write-amplification with no read
--    benefit, the same anti-pattern 0125 pruned:
--      - product_attribute_assignments_product_idx (product_id) ⊂ PK
--        (product_id, attribute_value_id);
--      - category_attribute_filters_category_idx (category_id) ⊂ PK
--        (category_id, attribute_id);
--      - product_variants_product_idx (product_id) ⊂
--        product_variants_order_idx (product_id, display_order).
--    A B-tree serves leading-column lookups (the "children of X" reads + FK
--    cascades) from the wider index, so the prefix index is dead weight. The
--    trailing-column indexes (…_value_idx / …_attribute_idx) are NOT prefixes and
--    stay.
--
-- Additive/idempotent: IF EXISTS / IF NOT EXISTS throughout.

DROP INDEX IF EXISTS "products_low_stock_idx";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "products_low_stock_idx"
  ON "products" ("stock_qty")
  WHERE "deleted_at" IS NULL AND "in_stock" = true AND "stock_qty" IS NOT NULL;
--> statement-breakpoint
DROP INDEX IF EXISTS "product_attribute_assignments_product_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "category_attribute_filters_category_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "product_variants_product_idx";
