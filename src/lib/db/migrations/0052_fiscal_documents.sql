-- 0052 — Fiscal/logistics document numbering (factures, avoirs, bons de
-- livraison). Idempotent.

-- Gapless per-(kind, period) counters. Bumped via INSERT … ON CONFLICT DO
-- UPDATE … RETURNING so concurrent issuance serializes on the row lock.
CREATE TABLE IF NOT EXISTS "document_sequences" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  "kind" text NOT NULL,
  "period" text NOT NULL,
  "current_value" bigint NOT NULL DEFAULT 0,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "document_sequences_kind_period_uniq" ON "document_sequences" ("kind", "period");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "document_sequences_kind_idx" ON "document_sequences" ("kind");--> statement-breakpoint

-- Document numbers stamped on the order (NULL until issued).
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "invoice_number" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "invoiced_at" timestamptz;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "credit_note_number" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "credit_note_at" timestamptz;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "delivery_note_number" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "delivery_note_at" timestamptz;--> statement-breakpoint

-- Each issued number is globally unique (partial — NULLs allowed before issue).
CREATE UNIQUE INDEX IF NOT EXISTS "orders_invoice_number_uniq" ON "orders" ("invoice_number") WHERE "invoice_number" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "orders_credit_note_number_uniq" ON "orders" ("credit_note_number") WHERE "credit_note_number" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "orders_delivery_note_number_uniq" ON "orders" ("delivery_note_number") WHERE "delivery_note_number" IS NOT NULL;
