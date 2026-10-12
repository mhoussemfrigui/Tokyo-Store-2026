-- 0050 — Returns (retours) taxonomy + comments for the Retours dashboard. Idempotent.
ALTER TABLE "order_returns" ADD COLUMN IF NOT EXISTS "reason_code" text;--> statement-breakpoint
ALTER TABLE "order_returns" ADD COLUMN IF NOT EXISTS "comment" text;--> statement-breakpoint
ALTER TABLE "order_return_items" ADD COLUMN IF NOT EXISTS "condition_note" text;--> statement-breakpoint
-- Dashboard aggregation: time-window scan + by-reason breakdown.
CREATE INDEX IF NOT EXISTS "order_returns_created_idx" ON "order_returns" ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "order_returns_reason_idx" ON "order_returns" ("reason_code");
