-- 0167 — new-customer « welcome » coupon flag.
--
-- A code coupon with first_order_only applies ONLY to a buyer's FIRST order
-- (no prior non-cancelled order). Account-based: a guest has no stable identity
-- to check reliably, so the coupon requires a signed-in account (enforced in
-- evaluateCouponEligibility → `account_required` / `not_first_order`). Meaningless
-- on an automatic promo (the auto-apply path has no buyer identity) — the manage
-- workflow rejects it there, same as targeting / free-shipping on auto.
ALTER TABLE "promotions" ADD COLUMN IF NOT EXISTS "first_order_only" boolean NOT NULL DEFAULT false;
