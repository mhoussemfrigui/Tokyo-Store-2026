-- Remove the preorder ("précommande") feature entirely. A watch store has no
-- preorders: every product follows the normal in-stock / stock_qty rules.
-- Drops the partial preorder index, rebuilds the admin stock index without the
-- now-removed is_preorder column, then drops the three preorder columns. The
-- product_badge enum keeps its legacy "PRECO" value (Postgres can't drop an enum
-- value cleanly); it is simply unreachable from the TS ProductBadge union now.
DROP INDEX IF EXISTS "products_preorder_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "products_stock_admin_idx";--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "products_stock_admin_idx"
  ON "products" ("in_stock", "created_at" DESC)
  WHERE "deleted_at" IS NULL;--> statement-breakpoint
ALTER TABLE "products" DROP COLUMN IF EXISTS "is_preorder", DROP COLUMN IF EXISTS "preorder_releases_at", DROP COLUMN IF EXISTS "preorder_message";
