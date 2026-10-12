-- 0158 — customer GENDER + its engagement-credit reward.
--
-- Adds an optional gender to customer_profiles. Two uses:
--   1. a SEGMENTATION dimension (targeting / personalisation);
--   2. a rewarded ENGAGEMENT action — the customer earns « +5 » store credit the
--      first time THEY provide it (« Actions récompensées » → provide_gender).
--
-- gender_provided_self_at mirrors the migration-0156 owner-provenance markers
-- (newsletter_optin_self_at / core_profile_self_completed_at): it is stamped ONLY on
-- the customer's OWN action, via the owner-actor grant subscriber. An admin/ERP write
-- that sets `gender` therefore never earns the customer unearned credit, and the
-- /account self-heal can safely recover a grant that was blocked by an unverified
-- email. NULL by default, NO backfill — a fresh column carries no owner-provenance.
--
-- gender is a small closed set (female | male | other) pinned by a CHECK — the same
-- belt-and-suspenders the order/gift-card status columns carry. NULL = not provided.
ALTER TABLE "customer_profiles"
  ADD COLUMN "gender" text,
  ADD COLUMN "gender_provided_self_at" timestamptz;--> statement-breakpoint
ALTER TABLE "customer_profiles" ADD CONSTRAINT "customer_profiles_gender_chk"
  CHECK ("gender" IS NULL OR "gender" IN ('female', 'male', 'other'));--> statement-breakpoint

-- The credit ledger gains the 'provide_gender' kind. One-per-wallet (the idempotency
-- backstop, mirroring credit_entries_newsletter_uq / _profile_complete_uq): a partial
-- unique index on the wallet WHERE kind = 'provide_gender'.
CREATE UNIQUE INDEX "credit_entries_provide_gender_uq"
  ON "customer_credit_entries" ("customer_profile_id") WHERE "kind" = 'provide_gender';--> statement-breakpoint

-- Widen the kind CHECK (0149) to admit the new kind. Drop + re-add with the full set.
ALTER TABLE "customer_credit_entries" DROP CONSTRAINT "customer_credit_entries_kind_chk";--> statement-breakpoint
ALTER TABLE "customer_credit_entries" ADD CONSTRAINT "customer_credit_entries_kind_chk" CHECK (
  "kind" IN (
    'spend', 'spend_reverse', 'refund', 'admin_adjust', 'referral', 'add_relative',
    'complete_relative_profile', 'complete_profile', 'newsletter_subscribe', 'life_stage',
    'giftcard_redeem', 'expiry', 'provide_gender'
  )
);
