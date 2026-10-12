-- 0153 — record whether an order's member discount was a BUSINESS (employee) one.
--
-- Lets the « les commandes avec remise entreprise comptent pour la fidélité »
-- toggle (business.orders_accrue_loyalty) exclude B2B-discounted orders from
-- loyalty accrual. Default false → every existing order keeps accruing (no
-- behaviour change until the toggle is turned off). Idempotent.
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "member_discount_is_business" boolean NOT NULL DEFAULT false;
