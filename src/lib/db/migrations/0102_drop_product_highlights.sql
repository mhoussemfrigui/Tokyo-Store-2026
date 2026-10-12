-- 0102 — drop the product "Caractéristiques clés" (highlights) feature.
--
-- The product highlights bullet list (PDP heading "Caractéristiques") and its
-- heading-override column are removed product-wide: backend, admin form,
-- storefront, and all AI generation (the `highlights` AI task + bulk-gen field).
-- This migration drops the now-unreferenced storage.
--
-- `product_highlights` is a standalone table (one row per bullet) with a
-- FK → products ON DELETE CASCADE; dropping the table is clean. The
-- `products.highlights_title` column held the optional per-product heading
-- override. Both are no longer read or written by any code path (the matching
-- schema/service/query/workflow/DTO/form/PDP code was removed in the same
-- change), so the drop is non-breaking. Irreversible — any operator-entered
-- highlights are discarded.
DROP TABLE IF EXISTS "product_highlights";
ALTER TABLE "products" DROP COLUMN IF EXISTS "highlights_title";
