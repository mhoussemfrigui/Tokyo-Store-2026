-- 0137 — Composite (parent_id, display_order) index for categories (perf, non-breaking).
--
-- The sibling reads all filter by parent then order by display_order:
--   * listChildren        WHERE parent_id = ? (or IS NULL) ... ORDER BY display_order, name
--   * reorderSiblings      the locked sibling SELECT (parent scope) + renumber
--   * countProductsForCategoryTrees' recursive CTE  (c.parent_id = sub.id join)
-- The standalone `categories_display_order_idx` (order without a parent prefix)
-- was never selectively used — a global order has no useful equality prefix — and
-- `categories_parent_idx` (parent_id only) is a strict prefix of the new
-- composite. So one (parent_id, display_order) index serves the parent-equality
-- lookups the parent-only index did AND answers the filter+sort in index order,
-- letting us drop BOTH old indexes with no capability gap and less write cost.

CREATE INDEX IF NOT EXISTS "categories_parent_display_order_idx"
  ON "categories" ("parent_id", "display_order");
DROP INDEX IF EXISTS "categories_display_order_idx";
DROP INDEX IF EXISTS "categories_parent_idx";
