-- 0142 — Global ERP-feed keyset index on the credit ledger
--
-- `creditService.listForApi()` (powering /api/loyalty/movements and, scoped,
-- /api/customers/[id]/loyalty) sorts the WHOLE ledger by ascending
-- (created_at, id) for incremental sync. The per-wallet index shipped in 0141
-- (customer_profile_id, created_at DESC, id DESC) covers the SCOPED read but not
-- the UNSCOPED global feed, which would otherwise fall back to a full-table sort.
-- Add the matching ASC (created_at, id) index — the same shape 0120 added for the
-- order/webhook ERP feeds.
CREATE INDEX IF NOT EXISTS "credit_entries_created_id_idx" ON "customer_credit_entries" ("created_at", "id");--> statement-breakpoint
