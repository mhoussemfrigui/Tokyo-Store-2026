-- 0120 — ERP incremental-feed sort indexes (stock_movements + coin_transactions).
--
-- Both ledgers back a keyset-paginated ERP feed that sorts GLOBALLY by
-- (created_at, id) with an empty or non-entity WHERE on the first page:
--   • stockMovementService.listForApi  → /api/stock/movements
--   • coinsService.listMovementsForApi  → /api/loyalty/movements
--
-- Their existing indexes lead with product_id / user_id (or are BRIN), so none
-- can supply globally-sorted output: Postgres seq-scans the whole append-only,
-- never-purged ledger and top-N sorts it, degrading as the table grows — and the
-- first sync page (empty WHERE) is a guaranteed full scan. The two sibling ERP
-- feeds (orders / customers) each got a dedicated single-column btree on their
-- sort column for exactly this reason; these two were missed.
--
-- A composite (created_at, id) btree EXACTLY matches the ORDER BY + id keyset
-- tiebreaker, giving an index-ordered, early-terminating LIMIT walk for both the
-- empty-WHERE first page and the incremental `created_at > since OR (created_at =
-- since AND id > sinceId)` pages. Strictly better than a single-column btree.
-- The existing coin_tx_created_at BRIN can stay (cheap; still prunes range scans).
--
-- Additive-only + idempotent.

CREATE INDEX IF NOT EXISTS "stock_movements_created_at_id_idx"
  ON "stock_movements" ("created_at", "id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "coin_tx_created_at_id_idx"
  ON "coin_transactions" ("created_at", "id");
