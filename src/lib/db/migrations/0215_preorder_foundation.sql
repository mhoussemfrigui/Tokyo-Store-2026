-- 0215 — précommande (preorder) foundation: product type + order markers + a
-- preorder stock-reservation ledger.
--
-- A preorder is a product sold BEFORE its stock arrives (`is_preorder` + a future
-- `preorder_releases_at`). Ordering one must NOT decrement sellable inventory and is
-- NOT recognized as revenue until CONVERSION (the product releases / an operator
-- confirms) — deferred-revenue. Instead a preorder line RESERVES units: a
-- `stock_reservations` row, summed into products/product_variants.reserved_qty, so
-- `available = stock_qty − reserved_qty`. Regular sales are UNCHANGED (Tokyo still
-- decrements at placement).
--
-- Data-model only — changes NO runtime behaviour on its own: every new column
-- defaults to a grandfathering value (is_preorder=false, reserved_qty=0, and
-- order_items.stock_claimed=TRUE because existing Tokyo lines WERE decremented at
-- placement), so availability/revenue are unchanged on deploy. `in_stock` is left
-- untouched (the operator's « En stock » toggle).

-- ── products / product_variants: preorder fields + reserved counter ──────────
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "is_preorder" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "preorder_releases_at" timestamptz;
--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "preorder_message" text;
--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "reserved_qty" integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "products" DROP CONSTRAINT IF EXISTS "products_reserved_qty_nonneg";
--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_reserved_qty_nonneg" CHECK ("reserved_qty" >= 0) NOT VALID;
--> statement-breakpoint
ALTER TABLE "product_variants" ADD COLUMN IF NOT EXISTS "reserved_qty" integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "product_variants" DROP CONSTRAINT IF EXISTS "product_variants_reserved_qty_nonneg";
--> statement-breakpoint
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_reserved_qty_nonneg" CHECK ("reserved_qty" >= 0) NOT VALID;
--> statement-breakpoint

-- Partial index over preorder rows only — the /admin/catalog/preorders queue +
-- the storefront preorder rail (tiny; is_preorder is rare).
CREATE INDEX IF NOT EXISTS "products_preorder_idx"
  ON "products" ("preorder_releases_at")
  WHERE "is_preorder" = true;
--> statement-breakpoint

-- ── orders / order_items: preorder overlay ──────────────────────────────────
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "is_preorder" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "preorder_converted_at" timestamptz;
--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN IF NOT EXISTS "is_preorder" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
-- Tokyo decrements at PLACEMENT, so existing/regular lines are CLAIMED (default
-- true); a preorder line is set false at placement and flipped true at conversion.
ALTER TABLE "order_items" ADD COLUMN IF NOT EXISTS "stock_claimed" boolean NOT NULL DEFAULT true;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "orders_preorder_idx"
  ON "orders" ("created_at" DESC)
  WHERE "is_preorder" = true;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "order_items_preorder_idx"
  ON "order_items" ("product_id")
  WHERE "is_preorder" = true;
--> statement-breakpoint

-- ── stock_reservations: open preorder holds (→ reserved_qty) ─────────────────
-- One row per reserved order line. `state`: open (live hold) → consumed (converted
-- to a real decrement) | released (cancelled before conversion, no restock). FKs
-- inline on a NEW empty table (instant). source is order-scoped.
CREATE TABLE IF NOT EXISTS "stock_reservations" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  "order_id" uuid NOT NULL REFERENCES "orders"("id") ON DELETE CASCADE,
  "order_item_id" uuid REFERENCES "order_items"("id") ON DELETE CASCADE,
  "product_id" uuid NOT NULL REFERENCES "products"("id") ON DELETE CASCADE,
  "variant_id" uuid REFERENCES "product_variants"("id") ON DELETE CASCADE,
  "qty" integer NOT NULL,
  "state" text NOT NULL DEFAULT 'open',
  "note" text,
  "actor_user_id" text,
  "released_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "stock_reservations_qty_pos" CHECK ("qty" > 0),
  CONSTRAINT "stock_reservations_state_valid" CHECK ("state" IN ('open', 'consumed', 'released'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stock_reservations_order_idx"
  ON "stock_reservations" ("order_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stock_reservations_open_product_idx"
  ON "stock_reservations" ("product_id", "variant_id")
  WHERE "state" = 'open';
