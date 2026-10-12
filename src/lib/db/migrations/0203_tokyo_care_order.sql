-- 0203 — Tokyo Care order snapshot. The paid protection add-on's charge lands on
-- the order: `orders.care_cents` is the AGGREGATE care charge (ex-tax; its TVA is
-- folded into orders.tax_cents like goods/shipping), and `order_care_items`
-- snapshots each care line (plan name + duration + per-unit price + qty + line
-- total + its TVA) so the order survives later plan edits or deletion.
-- `cart_items.care_plan_id` carries the shopper's per-line plan choice from the
-- cart through to checkout. Money is integer MILLIMES. The charge is ALWAYS
-- server-recomputed at placement — these columns are a SNAPSHOT, never trusted as
-- client input. `care_plan_id` is a SOFT reference (no cross-module FK, same as
-- order_items → products); `order_id`/`order_item_id` match order_items' app-level
-- integrity (no FK) so the whole order module stays FK-free internally.
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "care_cents" integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "cart_items" ADD COLUMN IF NOT EXISTS "care_plan_id" uuid;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "order_care_items" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
  "order_id" uuid NOT NULL,
  "order_item_id" uuid NOT NULL,
  "product_id" uuid NOT NULL,
  "care_plan_id" uuid NOT NULL,
  "plan_name" text NOT NULL,
  "duration_months" integer NOT NULL,
  "unit_care_cents" integer NOT NULL,
  "quantity" integer NOT NULL,
  "care_cents" integer NOT NULL,
  "tax_cents" integer NOT NULL DEFAULT 0,
  "tax_rate_bps" integer,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "order_care_qty_pos_chk" CHECK ("quantity" > 0)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "order_care_items_order_idx" ON "order_care_items" ("order_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "order_care_items_item_idx" ON "order_care_items" ("order_item_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "order_care_items_plan_idx" ON "order_care_items" ("care_plan_id");
