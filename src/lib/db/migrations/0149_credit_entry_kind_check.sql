-- 0149 — CREDIT WALLET: constrain customer_credit_entries.kind to the known ledger kinds.
--
-- The money-invariant partial-unique indexes (one-grant-per-kind, one-per-source-ref)
-- and the annual-earn ceiling sum all key on EXACT kind literals. A typo'd / unknown
-- kind would silently slip past every one of those guards, so pin the column to the
-- domain set (CREDIT_ENTRY_KINDS in src/modules/credit/schema.ts) at the DB — the same
-- belt-and-suspenders the gift_cards / order status columns already carry. Every kind
-- the app writes is in this list, so the constraint is inert for correct data.
ALTER TABLE "customer_credit_entries" ADD CONSTRAINT "customer_credit_entries_kind_chk" CHECK (
  "kind" IN (
    'spend', 'spend_reverse', 'refund', 'admin_adjust', 'referral', 'add_relative',
    'complete_relative_profile', 'complete_profile', 'newsletter_subscribe', 'life_stage',
    'giftcard_redeem', 'expiry'
  )
);--> statement-breakpoint
