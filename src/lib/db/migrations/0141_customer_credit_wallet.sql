-- 0141 — Customer store-credit wallet ("Crédit")
--
-- Replaces the never-wired `loyalty_bons` voucher table (shipped in 0140, no
-- grant path, no checkout consumption, no rows worth keeping) with a proper
-- store-credit WALLET, ported from Game Zone's `credit` subsystem.
--
-- Credit is « une avance » — real money the customer already holds (earned by
-- engagement actions, later by gift-card redemption / referral payouts). It is
-- NOT a discount: it never shrinks `orders.total_cents` (revenue + TVA stay on
-- the full basket); it SETTLES part of the order, so the gateway/COD only
-- collects `total_cents − credit_applied_cents`. On a full undo the applied
-- credit flows BACK into the wallet (never to cash).
--
-- Model: a denormalized `customer_profiles.credit_balance_cents` (fast reads,
-- never negative) kept in lockstep — inside one transaction — with an
-- append-only ledger `customer_credit_entries` (the audit truth; `balance_after_cents`
-- is the post-write snapshot). Money is integer millimes.
--
-- Cross-module FOREIGN KEYs added here (kept out of the Drizzle schema per the
-- modular-monolith rule): customer_credit_entries.customer_profile_id →
-- customer_profiles(id) CASCADE, and .order_id → orders(id) SET NULL.
--
-- SAFE: `loyalty_bons` has zero grant/consume wiring and no meaningful rows, so
-- dropping it loses nothing; all new columns default to 0 / empty.

-- ── (1) Drop the superseded voucher table (CASCADE clears its indexes/CHECKs/FKs).
DROP TABLE IF EXISTS "loyalty_bons" CASCADE;--> statement-breakpoint

-- ── (2) Denormalized wallet balance on the customer profile (never negative).
ALTER TABLE "customer_profiles" ADD COLUMN "credit_balance_cents" integer NOT NULL DEFAULT 0;--> statement-breakpoint
ALTER TABLE "customer_profiles" ADD CONSTRAINT "customer_profiles_credit_balance_nonneg_chk" CHECK ("credit_balance_cents" >= 0);--> statement-breakpoint

-- ── (3) Append-only credit ledger.
CREATE TABLE "customer_credit_entries" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
  "customer_profile_id" uuid NOT NULL,
  -- Signed millimes; never a no-op row.
  "amount_cents" integer NOT NULL,
  -- spend | spend_reverse | refund | admin_adjust | referral | add_relative |
  -- complete_relative_profile | complete_profile | newsletter_subscribe |
  -- life_stage | giftcard_redeem | expiry
  "kind" text NOT NULL,
  -- Wallet balance snapshot AFTER this row (from the UPDATE ... RETURNING).
  "balance_after_cents" integer NOT NULL,
  -- Set for order-settlement rows (spend / spend_reverse / refund).
  "order_id" uuid,
  -- Engagement/referral/gift-card dedupe key (referral id, life-stage claim id, …).
  "source_ref" text,
  -- Operator on a manual adjustment (auth user id; no FK — users may be pruned).
  "actor_user_id" text,
  "note" text,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "customer_credit_entries_amount_nonzero_chk" CHECK ("amount_cents" <> 0)
);--> statement-breakpoint
ALTER TABLE "customer_credit_entries" ADD CONSTRAINT "customer_credit_entries_profile_fk" FOREIGN KEY ("customer_profile_id") REFERENCES "customer_profiles"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "customer_credit_entries" ADD CONSTRAINT "customer_credit_entries_order_fk" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE SET NULL;--> statement-breakpoint

-- Statement + FK-probe path: newest-first ledger per wallet.
CREATE INDEX "credit_entries_profile_created_id_idx" ON "customer_credit_entries" ("customer_profile_id", "created_at" DESC, "id" DESC);--> statement-breakpoint
-- At-most-one spend and one reverse per order (settlement idempotency).
CREATE UNIQUE INDEX "credit_entries_order_spend_uq" ON "customer_credit_entries" ("order_id") WHERE "order_id" IS NOT NULL AND "kind" = 'spend';--> statement-breakpoint
CREATE UNIQUE INDEX "credit_entries_order_reverse_uq" ON "customer_credit_entries" ("order_id") WHERE "order_id" IS NOT NULL AND "kind" = 'spend_reverse';--> statement-breakpoint
CREATE INDEX "credit_entries_order_idx" ON "customer_credit_entries" ("order_id") WHERE "order_id" IS NOT NULL;--> statement-breakpoint
-- Engagement one-per-action guards (carry forward loyalty_bons' idempotency):
CREATE UNIQUE INDEX "credit_entries_newsletter_uq" ON "customer_credit_entries" ("customer_profile_id") WHERE "kind" = 'newsletter_subscribe';--> statement-breakpoint
CREATE UNIQUE INDEX "credit_entries_profile_complete_uq" ON "customer_credit_entries" ("customer_profile_id") WHERE "kind" = 'complete_profile';--> statement-breakpoint
-- Generic per-(wallet, source_ref) guard for referral / life-stage / relative grants.
CREATE UNIQUE INDEX "credit_entries_source_ref_uq" ON "customer_credit_entries" ("customer_profile_id", "source_ref") WHERE "source_ref" IS NOT NULL;--> statement-breakpoint

-- ── (4) Order settlement column: how much credit this order consumed.
ALTER TABLE "orders" ADD COLUMN "credit_applied_cents" integer NOT NULL DEFAULT 0;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_credit_applied_nonneg_chk" CHECK ("credit_applied_cents" >= 0);--> statement-breakpoint
-- Applied credit can never exceed the order total (NOT VALID: skip the full-table
-- scan — every existing row is 0, and the app clamps to total on write).
ALTER TABLE "orders" ADD CONSTRAINT "orders_credit_applied_le_total_chk" CHECK ("credit_applied_cents" <= "total_cents") NOT VALID;--> statement-breakpoint
CREATE INDEX "orders_credit_applied_idx" ON "orders" ("credit_applied_cents") WHERE "credit_applied_cents" > 0;--> statement-breakpoint

-- ── (5) Retire the dropped-table setting key (loyalty.bon.value_cents) → the
-- credit engagement value now lives under credit.engagement_value_cents; the
-- master switch is credit.mode (defaulted by the config resolver, seeded on first
-- admin save). Nothing to insert here.
DELETE FROM "site_settings" WHERE "key" IN ('loyalty.bon.value_cents', 'loyalty.bon.max_per_order');--> statement-breakpoint
