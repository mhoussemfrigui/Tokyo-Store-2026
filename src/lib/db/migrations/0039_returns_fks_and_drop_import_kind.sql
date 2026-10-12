-- 0039 — order-returns referential integrity (DB-FK-1) + drop the last dead
-- column (import_jobs.kind). Idempotent: each FK add is guarded on pg_constraint
-- (re-run = no-op) and the column drop uses IF EXISTS — so `db:migrate`
-- converges to the same shape on a fresh DB and on the live DB.

-- DB-FK-1 — order_returns / order_return_items were created (0014) WITHOUT the
-- foreign keys every sibling order-child table carries: in the baseline,
-- order_items / order_refunds / order_status_history all FK order_id → orders(id)
-- ON DELETE CASCADE. A hard-deleted order therefore orphaned its return rows.
-- Add the missing INTRA-module FKs to match that convention. `product_id` stays
-- a SOFT link (catalog is a separate module — mirrors order_items.product_id,
-- which has no FK either, per the cross-module rule).
--
-- Added NOT VALID: an existing DB may already hold orphan order_return_items
-- (return_id / order_item_id pointing at deleted parents — the Docker reverify
-- found such rows in dev), and a plain ADD CONSTRAINT would abort the whole
-- migration on them. NOT VALID skips the one-time scan of PRE-EXISTING rows but
-- STILL enforces the FK + ON DELETE CASCADE on every new write — which is the
-- goal. To fully validate later, clean the orphans then run
-- `ALTER TABLE <t> VALIDATE CONSTRAINT <name>;`.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'order_returns_order_id_fkey') THEN
    ALTER TABLE "order_returns"
      ADD CONSTRAINT "order_returns_order_id_fkey"
      FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE NOT VALID;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'order_return_items_return_id_fkey') THEN
    ALTER TABLE "order_return_items"
      ADD CONSTRAINT "order_return_items_return_id_fkey"
      FOREIGN KEY ("return_id") REFERENCES "order_returns"("id") ON DELETE CASCADE NOT VALID;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'order_return_items_order_item_id_fkey') THEN
    ALTER TABLE "order_return_items"
      ADD CONSTRAINT "order_return_items_order_item_id_fkey"
      FOREIGN KEY ("order_item_id") REFERENCES "order_items"("id") ON DELETE CASCADE NOT VALID;
  END IF;
END $$;--> statement-breakpoint

-- DB-DEAD-1 — drop the last proven-dead column. `import_jobs.kind` (added 0001,
-- generalized by 0002) has been write-only since the module moved to
-- operation/segment/source; it is omitted from the only read view
-- (service.ts DataJobView) and no code reads or writes it. The Drizzle schema
-- drops it in lockstep with this migration.
--
-- DEPLOY NOTE: `importJobService.findById` uses `db.select()` (names every
-- schema column), so an OLD app instance that still has `kind` in its schema
-- would error on import-job reads during a ROLLING-deploy overlap window. This
-- is safe under a stop-then-start redeploy (no overlap), or accept the brief
-- window — import jobs are admin-only and rarely read mid-deploy. (See the
-- 3-deploy rule in docs/deploy-runbook.md §10 for the fully-overlap-safe path.)
ALTER TABLE "import_jobs" DROP COLUMN IF EXISTS "kind";
