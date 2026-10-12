-- 0156 — engagement-credit OWNER PROVENANCE for the /account self-heal.
--
-- The /account self-heal re-grants the `newsletter_subscribe` / `complete_profile`
-- engagement credit for a customer who opted in / completed their profile BEFORE
-- verifying their email (those grants are gated on a verified email, so the first
-- attempt is a no-op and would otherwise be lost). The recovery read profile STATE
-- (marketing_opt_in true, core profile complete), so an ADMIN or ERP write that set
-- those fields for a customer who never performed the action themselves would earn
-- that customer unearned store credit on their next /account load — bypassing the
-- owner-actor gate the grant subscriber (grant-engagement-credit.ts) enforces.
--
-- These two nullable timestamps record that the OWNER themselves performed the
-- action. They are stamped ONLY on the owner-actor path (the grant subscriber, which
-- is already gated to the customer's own action, plus the customer's signup opt-in);
-- admin/ERP writes never set them. The self-heal now grants only when the matching
-- marker is present, restoring the anti-mis-attribution gate.
--
-- NULL by default, NO backfill: a fresh column carries no owner-provenance, so the
-- self-heal grants nothing it cannot attribute to the customer's own action. Already
-- CREDITED customers are unaffected (their grant is in the ledger; the self-heal skips
-- a kind it already sees). No index: these are read by primary-key on the /account load.
ALTER TABLE "customer_profiles"
  ADD COLUMN "newsletter_optin_self_at" timestamptz,
  ADD COLUMN "core_profile_self_completed_at" timestamptz;
