-- 0128 — Stock-transfer index hygiene (re-audit).
--
-- Three index corrections on the 0127 tables:
--
-- 1. The Transferts list's default (unfiltered) tab reads
--      WHERE deleted_at IS NULL ORDER BY created_at DESC, id DESC LIMIT n
--    No existing index leads with created_at (status_idx leads with status), so
--    that tab seq-scans + top-N sorts every load. A partial (created_at, id)
--    btree exactly matches the ORDER BY + id keyset tiebreaker (walked backward
--    for DESC), giving an index-ordered early-terminating LIMIT — the partial
--    predicate matches the query's `deleted_at IS NULL`. Mirrors 0120.
--
-- 2. stock_transfer_items_product_idx (product_id) is dead: transfer items are
--    only ever read BY transfer_id (transfer_idx) or JOINed on products.id — no
--    query filters items by product_id. Drop it (write cost with no read payoff).
--
-- 3. stock_transfers.ref is a display sequence (TR-<ref>) that must be unique;
--    the plain index never served a lookup (ref is only ever read off a returned
--    row). Promote it to UNIQUE so a stray manual insert can't duplicate a ref —
--    existing rows are sequence-generated and already distinct.
--
-- Idempotent.

CREATE INDEX IF NOT EXISTS "stock_transfers_created_at_id_idx"
  ON "stock_transfers" ("created_at", "id")
  WHERE "deleted_at" IS NULL;
--> statement-breakpoint
DROP INDEX IF EXISTS "stock_transfer_items_product_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "stock_transfers_ref_idx";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "stock_transfers_ref_idx" ON "stock_transfers" ("ref");
