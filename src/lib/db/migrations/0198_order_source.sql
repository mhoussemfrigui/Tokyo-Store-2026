-- 0198 — Order SOURCE (marketing / acquisition origin).
--
-- A nullable free-text column an operator sets on « Nouvelle commande » to
-- record WHERE the sale came from (Facebook / Instagram / TikTok / phone /
-- walk-in …). Distinct from `channel` (migration 0172), which is the technical
-- creation PATH (storefront / operator / express / erp). NULL for storefront /
-- express / erp orders. Allowed values come from the shared list in
-- src/lib/order/order-source.ts — extend there, no migration needed.
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "source" text;
