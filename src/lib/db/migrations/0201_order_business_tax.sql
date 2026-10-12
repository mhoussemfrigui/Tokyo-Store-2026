-- 0201 — « Vous êtes une entreprise ? » at checkout: a buyer self-declares a
-- business, enters a matricule fiscal, and an ADDITIVE TVA (default 19 %) is
-- applied on top of the grand total. Controlled from Commandes → Taxes →
-- « Entreprise » (tax.business.* settings); the TVA can be disabled, in which
-- case the matricule is still collected but no tax is added.
--
--   is_business        the buyer declared a business on this order.
--   business_tax_id    the entered matricule fiscal (NULL when not a business).
--   business_tax_cents the additive « entreprise » TVA applied (millimes; 0 when
--                      not a business or the tax is disabled).
--
-- Additive + defaulted so every existing order stays valid (not a business, no
-- extra tax). Distinct from the SHOP's own `business.tax_id` setting (document
-- issuer identity) and from `orders.member_discount_is_business` (account B2B).
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "is_business" boolean NOT NULL DEFAULT false;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "business_tax_id" text;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "business_tax_cents" integer NOT NULL DEFAULT 0;
