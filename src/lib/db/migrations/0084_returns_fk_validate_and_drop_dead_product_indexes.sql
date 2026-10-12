-- 0084 — finish the order-returns FK integrity scan (0039 added them NOT VALID)
-- + drop two never-queried product indexes (pure write amplification). Fully
-- idempotent: orphan cleanup converges to 0 rows, VALIDATE is guarded on
-- pg_constraint.convalidated, DROP INDEX uses IF EXISTS.

-- (1) Clean any PRE-0039 orphan return rows (parents hard-deleted before the FK
-- existed — the 0039 reverify found such rows in dev) so the NOT VALID FKs can be
-- promoted to fully-checked. Deleting an orphan return cascades to its items via
-- the already-active ON DELETE CASCADE; the follow-up deletes mop up any items
-- whose own parents vanished.
DELETE FROM "order_returns"
  WHERE "order_id" NOT IN (SELECT "id" FROM "orders");--> statement-breakpoint
DELETE FROM "order_return_items"
  WHERE "return_id" NOT IN (SELECT "id" FROM "order_returns");--> statement-breakpoint
DELETE FROM "order_return_items"
  WHERE "order_item_id" IS NOT NULL
    AND "order_item_id" NOT IN (SELECT "id" FROM "order_items");--> statement-breakpoint

-- (2) Promote the three NOT VALID FKs to validated (full referential integrity).
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'order_returns_order_id_fkey' AND NOT convalidated) THEN
    ALTER TABLE "order_returns" VALIDATE CONSTRAINT "order_returns_order_id_fkey";
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'order_return_items_return_id_fkey' AND NOT convalidated) THEN
    ALTER TABLE "order_return_items" VALIDATE CONSTRAINT "order_return_items_return_id_fkey";
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'order_return_items_order_item_id_fkey' AND NOT convalidated) THEN
    ALTER TABLE "order_return_items" VALIDATE CONSTRAINT "order_return_items_order_item_id_fkey";
  END IF;
END $$;--> statement-breakpoint

-- (3) Drop two low-cardinality, never-queried single-column indexes on products.
-- `in_stock` (boolean) and `badge` (nullable enum) are only ever read inside
-- COMPOUND predicates that the products_published_recent_idx + filters serve;
-- no query filters on either column alone, so these are write-only overhead.
-- The Drizzle schema drops the matching index declarations in lockstep.
DROP INDEX IF EXISTS "products_in_stock_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "products_badge_idx";
