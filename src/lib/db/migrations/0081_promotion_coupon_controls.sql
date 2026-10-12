-- Coupon controls — cross-reference parity with WooCommerce (exclude_sale_items
-- + maximum_amount), opt-in so defaults preserve today's behaviour.
--
-- exclude_discounted_items: when true, a cart-scope coupon's percent/flat discount
--   is computed on the NON-discounted lines only (lines already cut by an
--   auto product/category/brand promo are excluded from the coupon base), so a
--   code no longer stacks on top of already-on-sale items. Default false = stacks
--   (current behaviour).
-- max_cart_cents: optional UPPER bound (millimes) on the cart subtotal for the
--   coupon to apply — brackets a code to a target spend band (pairs with the
--   existing min_cart_cents lower bound). NULL = no upper bound.
ALTER TABLE promotions
  ADD COLUMN IF NOT EXISTS exclude_discounted_items boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS max_cart_cents integer;

ALTER TABLE promotions
  ADD CONSTRAINT promotions_max_cart_cents_check
    CHECK (max_cart_cents IS NULL OR max_cart_cents > 0);
