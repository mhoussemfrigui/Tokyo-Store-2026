-- 0204 — Remove six subsystems entirely: merchandising Collections, Drip &
-- Exclusivité / early-access / tier-release, Cartes cadeaux (gift cards), the
-- whole Fidélité/loyalty programme (niveaux + Cercle referral + life-stage
-- claims), the whole Entreprises/B2B programme, and Store credit ("Crédit
-- boutique"). This is a forward DROP migration (the app code for all six is
-- deleted). Idempotent (IF EXISTS / CASCADE) so a partial apply can be re-run.
-- NOTE: the SHOP's own fiscal identity settings `business.legal_name` /
-- `business.tax_id` (invoice issuer) are a DIFFERENT feature and are KEPT.

-- ── Drop the cross-module FK + indexes that depend on columns we drop below.
ALTER TABLE "customer_profiles" DROP CONSTRAINT IF EXISTS "customer_profiles_loyalty_level_fk";
DROP INDEX IF EXISTS "customer_profiles_loyalty_level_idx";
DROP INDEX IF EXISTS "faqs_collection_idx";
DROP INDEX IF EXISTS "products_early_access_idx";
DROP INDEX IF EXISTS "products_gift_card_idx";

-- ── orders: loyalty accrual, store-credit settlement, B2B TVA, gift recipient.
ALTER TABLE "orders" DROP COLUMN IF EXISTS "member_discount_is_business";
ALTER TABLE "orders" DROP COLUMN IF EXISTS "credit_applied_cents";
ALTER TABLE "orders" DROP COLUMN IF EXISTS "loyalty_accrued_at";
ALTER TABLE "orders" DROP COLUMN IF EXISTS "loyalty_spend_cents";
ALTER TABLE "orders" DROP COLUMN IF EXISTS "is_business";
ALTER TABLE "orders" DROP COLUMN IF EXISTS "business_tax_id";
ALTER TABLE "orders" DROP COLUMN IF EXISTS "business_tax_cents";
ALTER TABLE "orders" DROP COLUMN IF EXISTS "gift_recipient_email";
ALTER TABLE "orders" DROP COLUMN IF EXISTS "gift_recipient_name";
ALTER TABLE "orders" DROP COLUMN IF EXISTS "gift_message";

-- ── products: gift-card flag + drip/early-access release gating.
ALTER TABLE "products" DROP COLUMN IF EXISTS "drip_start_at";
ALTER TABLE "products" DROP COLUMN IF EXISTS "is_gift_card";
ALTER TABLE "products" DROP COLUMN IF EXISTS "early_access_enabled";

-- ── customer_profiles: loyalty niveau axes + store-credit wallet + loyalty mode
--    + the engagement-credit owner-provenance markers. `gender` / `birthday` /
--    `marketing_opt_in` / `promo_opt_out` / `external_ref` are KEPT.
ALTER TABLE "customer_profiles" DROP COLUMN IF EXISTS "cumulative_spend_cents";
ALTER TABLE "customer_profiles" DROP COLUMN IF EXISTS "paid_order_count";
ALTER TABLE "customer_profiles" DROP COLUMN IF EXISTS "loyalty_level_id";
ALTER TABLE "customer_profiles" DROP COLUMN IF EXISTS "credit_balance_cents";
ALTER TABLE "customer_profiles" DROP COLUMN IF EXISTS "loyalty_mode";
ALTER TABLE "customer_profiles" DROP COLUMN IF EXISTS "newsletter_optin_self_at";
ALTER TABLE "customer_profiles" DROP COLUMN IF EXISTS "core_profile_self_completed_at";
ALTER TABLE "customer_profiles" DROP COLUMN IF EXISTS "gender_provided_self_at";

-- ── faqs: the collection scope target. Rebuild the "at most one target" CHECK
--    without collection_id (num_nonnulls over the remaining three targets).
ALTER TABLE "faqs" DROP CONSTRAINT IF EXISTS "faqs_scope_target_chk";
ALTER TABLE "faqs" DROP COLUMN IF EXISTS "collection_id";
ALTER TABLE "faqs" ADD CONSTRAINT "faqs_scope_target_chk"
  CHECK (num_nonnulls(product_id, category_id, brand_id) <= 1);

-- ── Drop the subsystem tables (CASCADE clears their intra-subsystem FKs).
DROP TABLE IF EXISTS "product_collections" CASCADE;
DROP TABLE IF EXISTS "collections" CASCADE;
DROP TABLE IF EXISTS "product_tier_release" CASCADE;
DROP TABLE IF EXISTS "gift_cards" CASCADE;
DROP TABLE IF EXISTS "customer_credit_entries" CASCADE;
DROP TABLE IF EXISTS "loyalty_referrals" CASCADE;
DROP TABLE IF EXISTS "loyalty_life_stage_claims" CASCADE;
DROP TABLE IF EXISTS "loyalty_levels" CASCADE;
DROP TABLE IF EXISTS "business_level_allocations" CASCADE;
DROP TABLE IF EXISTS "business_members" CASCADE;
DROP TABLE IF EXISTS "business_join_requests" CASCADE;
DROP TABLE IF EXISTS "business_applications" CASCADE;
DROP TABLE IF EXISTS "business_levels" CASCADE;
DROP TABLE IF EXISTS "businesses" CASCADE;

-- ── Remove the removed features' persisted settings (code now resolves none of
--    these). Scoped to the feature prefixes — the shop identity keys
--    `business.legal_name` / `business.tax_id` are explicitly spared.
DELETE FROM "site_settings"
WHERE key LIKE 'loyalty.%'
   OR key LIKE 'credit.%'
   OR key LIKE 'cercle.%'
   OR key LIKE 'tax.business.%'
   OR key LIKE 'business.enabled'
   OR key LIKE 'business.join%'
   OR key LIKE 'business.orders_%'
   OR key LIKE 'business.discount_%'
   OR key LIKE 'auth.business.%'
   OR key LIKE 'pages.fidelite.%'
   OR key LIKE 'pages.collections.%'
   OR key LIKE 'drip.%'
   OR key LIKE 'giftcard.%'
   OR key LIKE 'gift_card.%';
