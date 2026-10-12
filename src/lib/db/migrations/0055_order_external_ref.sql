-- 0055 — ERP linking: a stable external reference on orders. Idempotent.
-- Opaque code from an external system (ERP / WMS / 3PL) for two-way sync over
-- the keyed order API. Unique when set (partial — NULLs allowed pre-link).
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "external_ref" text;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "orders_external_ref_uniq" ON "orders" ("external_ref") WHERE "external_ref" IS NOT NULL;--> statement-breakpoint
-- Incremental sync (?since=) pages by updated_at.
CREATE INDEX IF NOT EXISTS "orders_updated_at_idx" ON "orders" ("updated_at");
