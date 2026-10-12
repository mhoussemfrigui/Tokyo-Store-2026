-- 0150 — drop the redundant product_tier_release(product_id) index.
--
-- The composite UNIQUE ptr_product_ladder_level_unique (product_id, ladder, level_id)
-- already covers every product_id-PREFIX lookup: listForProducts' `inArray(product_id)`,
-- listForProduct / setForProduct's `product_id = X`, and the FK cascade scan when a
-- product is deleted. A standalone ptr_product_idx (product_id) therefore adds pure write
-- overhead (an extra index to maintain on every insert/delete) with no read benefit.
-- Follows the 0125 precedent of pruning indexes subsumed by a composite. Idempotent.
DROP INDEX IF EXISTS "ptr_product_idx";
