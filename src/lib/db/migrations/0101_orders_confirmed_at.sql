-- 0101 — explicit order CONFIRMATION timestamp.
--
-- The customer "Suivi de livraison" stepper used to light its first step
-- ("Confirmée") for ANY live order, because it derived that step from the
-- single status enum (pending+paid both read "Confirmée") — so an order looked
-- confirmed the instant it was placed, with no operator/payment act gating it.
--
-- `confirmed_at` makes confirmation a real, persisted moment: set automatically
-- when an ONLINE order settles (transition to `paid`), set MANUALLY by the
-- operator "Confirmer la commande" action for COD (placed/awaiting acceptance),
-- and back-stopped on any forward transition (preparing/shipped/delivered) so
-- the stepper can never show a later step lit while "Confirmée" is not.
-- NULL = received but not yet confirmed.
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "confirmed_at" timestamptz;

-- Backfill: every order that already progressed past `pending` was implicitly
-- confirmed — stamp it from paid_at (or creation) so historical stepper/history
-- views render correctly. Terminal pending/cancelled/refunded stay NULL.
UPDATE "orders"
   SET "confirmed_at" = COALESCE("paid_at", "created_at")
 WHERE "status" IN ('paid', 'preparing', 'shipped', 'delivered')
   AND "confirmed_at" IS NULL;
