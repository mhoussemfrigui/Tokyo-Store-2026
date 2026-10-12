-- 0133 — Track waived shipping on a promotion redemption.
--
-- The promotion "Performance" stats summed only discount_cents, so a
-- free-shipping coupon (discount_cents = 0) reported a revenue impact of 0 even
-- though the store ate the shipping fee. Record the waived shipping amount on the
-- redemption row so statsForPromotion can add it to the true cost, and so a
-- reversal (refund/cancel) can net it out exactly like discount_cents. NOT NULL
-- DEFAULT 0 backfills existing rows as "unknown → 0" (no historical waived value
-- is recoverable); additive + idempotent.

ALTER TABLE "promotion_redemptions"
  ADD COLUMN IF NOT EXISTS "shipping_waived_cents" integer DEFAULT 0 NOT NULL;
