-- 0127 — Inter-location stock transfers (stores ↔ central depot).
--
-- A transfer is a request that walks requested → accepted → in_transit →
-- completed (or → cancelled). Physical stock only MOVES on completion — each
-- line's source stock_level −qty and destination +qty, two `transfer` ledger
-- legs — so the authoritative product/variant stock_qty TOTAL is unchanged by a
-- transfer (units relocate; see stockLocationService.moveStockTx). from/to/order
-- are SOFT uuid links (no FK) so a transfer keeps its history if a location,
-- order, product or variant is later removed — same rationale as stock_movements.
--
-- Purely structural; changes no runtime behaviour until the Transferts UI + the
-- (later) auto-request-on-order path use it.

-- Human display sequence (TR-<ref>), race-free vs count(*)+1.
CREATE SEQUENCE IF NOT EXISTS "stock_transfer_ref_seq";

CREATE TABLE IF NOT EXISTS "stock_transfers" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  "ref" integer NOT NULL DEFAULT nextval('stock_transfer_ref_seq'),
  "from_location_id" uuid NOT NULL,
  "to_location_id" uuid NOT NULL,
  "status" text NOT NULL DEFAULT 'requested',
  "source" text NOT NULL DEFAULT 'manual',
  "order_id" uuid,
  "note" text,
  "requested_by" text,
  "accepted_at" timestamptz,
  "dispatched_at" timestamptz,
  "completed_at" timestamptz,
  "cancelled_at" timestamptz,
  "cancel_reason" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "deleted_at" timestamptz,
  CONSTRAINT "stock_transfers_different_locations" CHECK ("from_location_id" <> "to_location_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stock_transfers_status_idx" ON "stock_transfers" ("status", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stock_transfers_from_idx" ON "stock_transfers" ("from_location_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stock_transfers_to_idx" ON "stock_transfers" ("to_location_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stock_transfers_order_idx" ON "stock_transfers" ("order_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stock_transfers_ref_idx" ON "stock_transfers" ("ref");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "stock_transfer_items" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  "transfer_id" uuid NOT NULL REFERENCES "stock_transfers"("id") ON DELETE CASCADE,
  "product_id" uuid NOT NULL,
  "variant_id" uuid,
  "qty" integer NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "stock_transfer_items_qty_positive" CHECK ("qty" > 0)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stock_transfer_items_transfer_idx" ON "stock_transfer_items" ("transfer_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stock_transfer_items_product_idx" ON "stock_transfer_items" ("product_id");
