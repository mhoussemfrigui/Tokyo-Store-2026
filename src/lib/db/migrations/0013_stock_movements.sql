-- Append-only stock-movement ledger: one row per stock change — sale (order),
-- cancellation, return-receive, external API delta/set, product- AND
-- variant-level admin edits, and the digital key-pool re-sync (`digital_sync`).
-- Opening balances are not ledgered. Written in the same tx as the mutation so
-- the net change is reconstructable + ERP-reconcilable. Idempotent.
CREATE TABLE IF NOT EXISTS "stock_movements" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  "product_id" uuid NOT NULL,
  "variant_id" text,
  "delta" integer NOT NULL,
  "resulting_qty" integer,
  "reason" text NOT NULL,
  "order_id" uuid,
  "actor_user_id" text,
  "note" text,
  "created_at" timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stock_movements_product_idx" ON "stock_movements" ("product_id", "created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stock_movements_order_idx" ON "stock_movements" ("order_id");
