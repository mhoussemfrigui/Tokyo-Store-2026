-- Customer returns (retours / RMA). A return lists the lines coming back; on
-- RECEIVE the resellable lines restock (idempotent per line via restocked_at).
-- Money stays in order_refunds. Idempotent DDL.
DO $$ BEGIN
  CREATE TYPE "order_return_status" AS ENUM ('pending', 'received', 'rejected');
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "order_returns" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  "order_id" uuid NOT NULL,
  "status" "order_return_status" NOT NULL DEFAULT 'pending',
  "reason" text,
  "created_by_user_id" text,
  "processed_by_user_id" text,
  "processed_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "order_returns_order_idx" ON "order_returns" ("order_id");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "order_return_items" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  "return_id" uuid NOT NULL,
  "order_item_id" uuid NOT NULL,
  "product_id" uuid NOT NULL,
  "variant_id" text,
  "quantity" integer NOT NULL,
  "restockable" boolean NOT NULL DEFAULT true,
  "restocked_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "order_return_items_return_idx" ON "order_return_items" ("return_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "order_return_items_order_item_idx" ON "order_return_items" ("order_item_id");
