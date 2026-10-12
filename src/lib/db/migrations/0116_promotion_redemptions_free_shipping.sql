-- 0116 — promotion_redemptions.free_shipping marker.
--
-- A free-shipping-only coupon contributes discount_cents = 0, so the redemption
-- block in place-order.ts (gated on `discount_cents > 0`) skipped it entirely
-- and its max_uses / max_uses_per_user caps NEVER bound — unbounded free
-- shipping even though the admin form accepted the caps. This marker lets the
-- per-user cap count free-ship redemptions (countRedemptionsByUser now ORs it
-- in), while the refund/cancel reversal — which reverses only `discount_cents >
-- 0` rows — leaves a free-ship redemption CONSUMED, so uses_count never drifts.
--
-- Additive-only. NOT NULL with a DEFAULT so every existing row backfills to
-- false; IF NOT EXISTS keeps it re-runnable.

ALTER TABLE "promotion_redemptions"
  ADD COLUMN IF NOT EXISTS "free_shipping" boolean NOT NULL DEFAULT false;
