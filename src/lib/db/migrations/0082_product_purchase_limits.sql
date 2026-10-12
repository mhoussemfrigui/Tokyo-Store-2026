-- Per-product purchase-quantity limits (cross-reference parity with PrestaShop
-- minimal_quantity + WooCommerce sold-individually). Both NULL = no limit
-- (current behaviour). "Sold individually" = max_purchase_qty = 1.
-- Enforced PER ORDER PER PRODUCT: place-order sums the quantity across a
-- product's sibling variant lines before checking, so the cap can't be beaten by
-- splitting qty across variants.
--   min_purchase_qty: a buyer must order at least N of this product per order.
--   max_purchase_qty: a buyer may order at most N per order (e.g. 1 on a restock).
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS min_purchase_qty integer,
  ADD COLUMN IF NOT EXISTS max_purchase_qty integer;

ALTER TABLE products
  ADD CONSTRAINT products_min_purchase_qty_check
    CHECK (min_purchase_qty IS NULL OR min_purchase_qty >= 1),
  ADD CONSTRAINT products_max_purchase_qty_check
    CHECK (max_purchase_qty IS NULL OR max_purchase_qty >= 1),
  ADD CONSTRAINT products_purchase_qty_order_check
    CHECK (
      min_purchase_qty IS NULL
      OR max_purchase_qty IS NULL
      OR max_purchase_qty >= min_purchase_qty
    );
