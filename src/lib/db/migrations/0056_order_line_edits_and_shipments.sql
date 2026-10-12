-- 0056 — Partial-shipment bons de livraison (one order → many BLs). Idempotent.
-- Operator order-line editing reuses existing order_items (no new column); the
-- shipped quantity per line is DERIVED as SUM(shipment_items.quantity).

CREATE TABLE IF NOT EXISTS "shipments" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  "order_id" uuid NOT NULL,
  "delivery_note_number" text NOT NULL,
  "delivery_note_at" timestamptz NOT NULL DEFAULT now(),
  "delivery_method" "delivery_method",
  "delivery_agent_name" text,
  "tracking_ref" text,
  "shipped_at" timestamptz,
  "created_by_user_id" text,
  "notes" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "shipment_items" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  "shipment_id" uuid NOT NULL,
  "order_item_id" uuid NOT NULL,
  "quantity" integer NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "shipments_order_idx" ON "shipments" ("order_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "shipments_delivery_note_number_uniq" ON "shipments" ("delivery_note_number");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shipment_items_shipment_idx" ON "shipment_items" ("shipment_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shipment_items_order_item_idx" ON "shipment_items" ("order_item_id");--> statement-breakpoint
-- One row per (shipment, order line); per-line over-ship is guarded in the
-- workflow against SUM(shipment_items.quantity) ≤ order_items.quantity.
CREATE UNIQUE INDEX IF NOT EXISTS "shipment_items_shipment_order_item_uniq" ON "shipment_items" ("shipment_id", "order_item_id");--> statement-breakpoint

-- FKs (CASCADE mirrors deleteOrderById's child-cleanup discipline). Guarded so a
-- re-run doesn't error on an already-present constraint.
DO $$ BEGIN
  ALTER TABLE "shipments" ADD CONSTRAINT "shipments_order_id_fk" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "shipment_items" ADD CONSTRAINT "shipment_items_shipment_id_fk" FOREIGN KEY ("shipment_id") REFERENCES "shipments"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "shipment_items" ADD CONSTRAINT "shipment_items_order_item_id_fk" FOREIGN KEY ("order_item_id") REFERENCES "order_items"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "shipment_items" ADD CONSTRAINT "shipment_items_qty_pos" CHECK ("quantity" > 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
