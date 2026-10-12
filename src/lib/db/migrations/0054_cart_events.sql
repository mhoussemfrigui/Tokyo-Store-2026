-- 0054 — Add-to-cart event log (most-added-to-cart analytics). Idempotent.
CREATE TABLE IF NOT EXISTS "cart_events" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  "product_id" uuid NOT NULL,
  "variant_id" text NOT NULL DEFAULT '',
  "quantity" integer NOT NULL DEFAULT 1,
  "actor_kind" text NOT NULL,
  "source" text NOT NULL DEFAULT 'cart',
  "occurred_at" timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint
-- Window scan (last 7/30 days) + per-product breakdown.
CREATE INDEX IF NOT EXISTS "cart_events_occurred_idx" ON "cart_events" ("occurred_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cart_events_product_occurred_idx" ON "cart_events" ("product_id", "occurred_at");
