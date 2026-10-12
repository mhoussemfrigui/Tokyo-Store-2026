-- 0140 — Loyalty rebuild: "Le Cercle de Famille" (tiers-only; points/coins removed)
--
-- The loyalty program becomes TIERS-ONLY (niveaux). The spendable points/coins
-- half is removed entirely (wallet, redemption, coin ledger). Progression is now
-- CUMULATIVE PAID SPEND (millimes) + a MINIMUM PAID-ORDER COUNT per level.
-- Everything coins→loyalty is renamed (tables, columns, settings, RBAC). Three
-- new subsystems are added: engagement bons (vouchers), the family/friends
-- referral Cercle (consent accounts), and verified life-stage claims.
--
-- SAFE because in production loyalty runs in "tiers" mode where redemption is
-- already forced off (resolveCoinsConfig) — no coins_discount_cents>0 rows exist.
--
-- Cross-module FOREIGN KEYs added here (kept out of Drizzle schema per the
-- modular-monolith rule): loyalty_bons.user_id / .consumed_order_id,
-- loyalty_referrals.referrer_user_id / .referred_user_id,
-- loyalty_life_stage_claims.user_id / .verified_by, and the denormalized
-- customer_profiles.loyalty_level_id → loyalty_levels.

-- ─────────────────────────────────────────────────────────────────────────────
-- (1) coin_levels → loyalty_levels  (tier definitions; spend+count basis)
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "coin_levels" RENAME TO "loyalty_levels";--> statement-breakpoint
ALTER TABLE "loyalty_levels" RENAME COLUMN "threshold_coins" TO "threshold_spend_cents";--> statement-breakpoint
ALTER TABLE "loyalty_levels" ADD COLUMN "min_purchases" integer NOT NULL DEFAULT 0;--> statement-breakpoint
ALTER TABLE "loyalty_levels" ADD COLUMN "first_purchase_discount_pct" integer;--> statement-breakpoint
-- Drop the spendable-points perks (DROP COLUMN also drops their column CHECKs).
ALTER TABLE "loyalty_levels" DROP COLUMN "earn_multiplier_bps";--> statement-breakpoint
ALTER TABLE "loyalty_levels" DROP COLUMN "max_redeem_pct";--> statement-breakpoint
ALTER TABLE "loyalty_levels" DROP COLUMN "free_shipping_threshold_cents";--> statement-breakpoint
-- Re-point / rename the surviving CHECKs + add the new ones.
ALTER TABLE "loyalty_levels" DROP CONSTRAINT IF EXISTS "coin_levels_threshold_coins_nonneg_chk";--> statement-breakpoint
ALTER TABLE "loyalty_levels" ADD CONSTRAINT "loyalty_levels_threshold_spend_nonneg_chk" CHECK ("threshold_spend_cents" >= 0);--> statement-breakpoint
ALTER TABLE "loyalty_levels" ADD CONSTRAINT "loyalty_levels_min_purchases_nonneg_chk" CHECK ("min_purchases" >= 0);--> statement-breakpoint
ALTER TABLE "loyalty_levels" ADD CONSTRAINT "loyalty_levels_first_purchase_discount_pct_chk" CHECK ("first_purchase_discount_pct" IS NULL OR ("first_purchase_discount_pct" >= 0 AND "first_purchase_discount_pct" <= 100));--> statement-breakpoint
ALTER TABLE "loyalty_levels" RENAME CONSTRAINT "coin_levels_flat_discount_pct_chk" TO "loyalty_levels_flat_discount_pct_chk";--> statement-breakpoint
ALTER TABLE "loyalty_levels" RENAME CONSTRAINT "coin_levels_early_access_delay_check" TO "loyalty_levels_early_access_delay_check";--> statement-breakpoint
ALTER INDEX "coin_levels_threshold_idx" RENAME TO "loyalty_levels_threshold_idx";--> statement-breakpoint
ALTER INDEX "coin_levels_display_order_idx" RENAME TO "loyalty_levels_display_order_idx";--> statement-breakpoint
ALTER INDEX "coin_levels_pkey" RENAME TO "loyalty_levels_pkey";--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- (2) coin_transactions — DROP (spendable points ledger dies)
--     CASCADE removes all its indexes (incl. coin_tx_created_at_id_idx from 0120),
--     CHECKs and FKs in one shot.
-- ─────────────────────────────────────────────────────────────────────────────
DROP TABLE IF EXISTS "coin_transactions" CASCADE;--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- (3) customer_profiles — drop wallet, repurpose lifetime→cumulative spend,
--     add order count + denormalized level.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "customer_profiles" DROP COLUMN "loyalty_points";--> statement-breakpoint
ALTER TABLE "customer_profiles" RENAME COLUMN "lifetime_coins_earned" TO "cumulative_spend_cents";--> statement-breakpoint
ALTER TABLE "customer_profiles" ADD COLUMN "paid_order_count" integer NOT NULL DEFAULT 0;--> statement-breakpoint
ALTER TABLE "customer_profiles" ADD COLUMN "loyalty_level_id" uuid;--> statement-breakpoint
ALTER TABLE "customer_profiles" ADD CONSTRAINT "customer_profiles_loyalty_level_fk" FOREIGN KEY ("loyalty_level_id") REFERENCES "loyalty_levels"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "customer_profiles" ADD CONSTRAINT "customer_profiles_cumulative_spend_nonneg_chk" CHECK ("cumulative_spend_cents" >= 0);--> statement-breakpoint
ALTER TABLE "customer_profiles" ADD CONSTRAINT "customer_profiles_paid_order_count_nonneg_chk" CHECK ("paid_order_count" >= 0);--> statement-breakpoint
CREATE INDEX "customer_profiles_loyalty_level_idx" ON "customer_profiles" ("loyalty_level_id");--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- (4) orders — drop coins spend, add accrual idempotency guard (D3).
--     COD delivery fires the accrual hook twice (order.paid + status→delivered);
--     loyalty_accrued_at makes the accrual a one-shot and loyalty_spend_cents
--     makes reversal exact.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "orders" DROP COLUMN "coins_points_spent";--> statement-breakpoint
ALTER TABLE "orders" DROP COLUMN "coins_discount_cents";--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "loyalty_accrued_at" timestamptz;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "loyalty_spend_cents" integer;--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- (5) loyalty_bons — engagement voucher ledger (+5 DT actions). NEW.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE "loyalty_bons" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
  "user_id" text NOT NULL,
  "value_cents" integer NOT NULL DEFAULT 5000,
  "earn_action" text NOT NULL,
  "status" text NOT NULL DEFAULT 'active',
  "consumed_order_id" uuid,
  "source_ref" text,
  "expires_at" timestamptz,
  "note" text,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "loyalty_bons_value_pos_chk" CHECK ("value_cents" > 0),
  CONSTRAINT "loyalty_bons_earn_action_chk" CHECK ("earn_action" IN ('add_relative','complete_relative_profile','complete_profile','newsletter_subscribe','life_stage_verified','manual')),
  CONSTRAINT "loyalty_bons_status_chk" CHECK ("status" IN ('active','consumed','expired','revoked'))
);--> statement-breakpoint
ALTER TABLE "loyalty_bons" ADD CONSTRAINT "loyalty_bons_user_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "loyalty_bons" ADD CONSTRAINT "loyalty_bons_order_fk" FOREIGN KEY ("consumed_order_id") REFERENCES "orders"("id") ON DELETE SET NULL;--> statement-breakpoint
CREATE INDEX "loyalty_bons_user_status_idx" ON "loyalty_bons" ("user_id", "status");--> statement-breakpoint
CREATE INDEX "loyalty_bons_order_idx" ON "loyalty_bons" ("consumed_order_id");--> statement-breakpoint
-- Idempotency: one newsletter bon + one profile-complete bon per user; one bon
-- per (user, source_ref) for referral / life-stage grants.
CREATE UNIQUE INDEX "loyalty_bons_newsletter_uq" ON "loyalty_bons" ("user_id") WHERE "earn_action" = 'newsletter_subscribe';--> statement-breakpoint
CREATE UNIQUE INDEX "loyalty_bons_profile_uq" ON "loyalty_bons" ("user_id") WHERE "earn_action" = 'complete_profile';--> statement-breakpoint
CREATE UNIQUE INDEX "loyalty_bons_source_ref_uq" ON "loyalty_bons" ("user_id", "source_ref") WHERE "source_ref" IS NOT NULL;--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- (6) loyalty_referrals — family/friends Cercle graph w/ consent (NEW, association)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE "loyalty_referrals" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
  "referrer_user_id" text NOT NULL,
  "referred_user_id" text,
  "referred_email" text,
  "relationship" text,
  "consent_state" text NOT NULL DEFAULT 'invited',
  "invite_token" text,
  "accepted_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "loyalty_referrals_consent_chk" CHECK ("consent_state" IN ('invited','accepted','declined','revoked')),
  CONSTRAINT "loyalty_referrals_no_self_chk" CHECK ("referred_user_id" IS NULL OR "referred_user_id" <> "referrer_user_id")
);--> statement-breakpoint
ALTER TABLE "loyalty_referrals" ADD CONSTRAINT "loyalty_referrals_referrer_fk" FOREIGN KEY ("referrer_user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "loyalty_referrals" ADD CONSTRAINT "loyalty_referrals_referred_fk" FOREIGN KEY ("referred_user_id") REFERENCES "users"("id") ON DELETE SET NULL;--> statement-breakpoint
CREATE INDEX "loyalty_referrals_referrer_idx" ON "loyalty_referrals" ("referrer_user_id");--> statement-breakpoint
CREATE INDEX "loyalty_referrals_referred_idx" ON "loyalty_referrals" ("referred_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "loyalty_referrals_token_uq" ON "loyalty_referrals" ("invite_token") WHERE "invite_token" IS NOT NULL;--> statement-breakpoint
-- No duplicate accepted edge between the same two accounts.
CREATE UNIQUE INDEX "loyalty_referrals_edge_uq" ON "loyalty_referrals" ("referrer_user_id", "referred_user_id") WHERE "referred_user_id" IS NOT NULL;--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- (7) loyalty_life_stage_claims — verified life-stage declarations (NEW)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE "loyalty_life_stage_claims" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
  "user_id" text NOT NULL,
  "stage" text NOT NULL,
  "social_link" text NOT NULL,
  "status" text NOT NULL DEFAULT 'pending',
  "verified_by" text,
  "verified_at" timestamptz,
  "note" text,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "loyalty_life_stage_status_chk" CHECK ("status" IN ('pending','verified','rejected'))
);--> statement-breakpoint
ALTER TABLE "loyalty_life_stage_claims" ADD CONSTRAINT "loyalty_life_stage_user_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "loyalty_life_stage_claims" ADD CONSTRAINT "loyalty_life_stage_verified_by_fk" FOREIGN KEY ("verified_by") REFERENCES "users"("id") ON DELETE SET NULL;--> statement-breakpoint
CREATE INDEX "loyalty_life_stage_user_idx" ON "loyalty_life_stage_claims" ("user_id");--> statement-breakpoint
CREATE INDEX "loyalty_life_stage_status_idx" ON "loyalty_life_stage_claims" ("status", "created_at");--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- (8) Data migrations — settings, RBAC, segments. (Keep un-migrated data working.)
-- ─────────────────────────────────────────────────────────────────────────────
-- Setting keys: coins.enabled → loyalty.enabled; drop the spendable-points keys;
-- move the group label. (loyalty.mode / .stack.* / .qr_ttl_seconds keep names;
-- mode/qr become inert and are ignored by the new reader.)
UPDATE "site_settings" SET "key" = 'loyalty.enabled' WHERE "key" = 'coins.enabled';--> statement-breakpoint
UPDATE "site_settings" SET "group_key" = 'loyalty' WHERE "group_key" = 'coins';--> statement-breakpoint
DELETE FROM "site_settings" WHERE "key" IN ('coins.redemption_enabled','coins.earn_points_per_tnd','coins.redeem_value_cents_per_point','coins.max_redeem_pct_default','coins.min_redeem_points','loyalty.qr_ttl_seconds','loyalty.mode');--> statement-breakpoint
-- RBAC: resource id coins → loyalty (else isValidPermissionKey drops the grant).
UPDATE "role_permissions" SET "permission" = replace("permission", 'coins:', 'loyalty:') WHERE "permission" LIKE 'coins:%';--> statement-breakpoint
-- Dynamic segment rules: min_lifetime_coins:<n> is a coins basis — reset those
-- rules to blank (the admin re-picks a min_lifetime_spend / min_purchases rule);
-- a silent 1000-coins→1000-millimes remap would be wrong.
UPDATE "customer_segments" SET "rule" = NULL WHERE "kind" = 'dynamic' AND "rule" LIKE 'min_lifetime_coins:%';--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- (9) Backfill — cumulative spend + order count + level, from PAID orders.
--     Basis (D2) = SUM(orders.total_cents) of paid orders per user.
-- ─────────────────────────────────────────────────────────────────────────────
-- Reset first (the renamed column still holds stale COIN values, not millimes).
UPDATE "customer_profiles" SET "cumulative_spend_cents" = 0, "paid_order_count" = 0;--> statement-breakpoint
UPDATE "customer_profiles" cp SET
  "cumulative_spend_cents" = paid.spend,
  "paid_order_count" = paid.cnt
FROM "customer_user_links" cul
JOIN (
  SELECT "user_id", SUM("total_cents")::int AS spend, COUNT(*)::int AS cnt
  FROM "orders"
  WHERE "user_id" IS NOT NULL AND "status" IN ('paid','preparing','shipped','delivered')
  GROUP BY "user_id"
) paid ON paid."user_id" = cul."user_id"
WHERE cul."customer_profile_id" = cp."id";--> statement-breakpoint
-- Denormalized level = highest enabled level whose spend AND count gates are met.
UPDATE "customer_profiles" cp SET "loyalty_level_id" = (
  SELECT ll."id" FROM "loyalty_levels" ll
  WHERE ll."enabled" = true
    AND ll."threshold_spend_cents" <= cp."cumulative_spend_cents"
    AND ll."min_purchases" <= cp."paid_order_count"
  ORDER BY ll."threshold_spend_cents" DESC, ll."min_purchases" DESC, ll."display_order" DESC
  LIMIT 1
);--> statement-breakpoint
-- Stamp already-paid orders so the accrual hook never re-counts them.
UPDATE "orders" SET "loyalty_accrued_at" = now(), "loyalty_spend_cents" = "total_cents"
WHERE "status" IN ('paid','preparing','shipped','delivered');--> statement-breakpoint
