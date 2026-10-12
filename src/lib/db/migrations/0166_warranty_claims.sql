-- 0166 — warranty claims (SAV / RMA).
--
-- A claim is raised against ONE sold line (order_item_id) that a customer brings
-- in for service; unlike a return (header + lines) it is a single row per unit.
-- The warranty COVERAGE is snapshotted at claim time (warranty_months / _label /
-- covered_until / was_covered), computed from the order line's own snapshot, so
-- the record always shows what the customer was entitled to even after the
-- product's warranty config later changes. Money stays in order_refunds; a claim
-- records the service case only. external_ref links to an ERP/repair-shop record
-- for two-way sync (unique when set).
--
-- FKs inlined REFERENCES (fresh table → no pre-existing orphans, unlike the
-- order_returns retrofit): order_id / order_item_id CASCADE with the order.
-- product_id / variant_id stay SOFT (no FK — catalog is a separate module).
DO $$ BEGIN
  CREATE TYPE "warranty_claim_status" AS ENUM ('open', 'in_repair', 'awaiting_parts', 'resolved', 'rejected');
EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE TABLE IF NOT EXISTS "warranty_claims" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  "order_id" uuid NOT NULL REFERENCES "orders" ("id") ON DELETE CASCADE,
  "order_item_id" uuid NOT NULL REFERENCES "order_items" ("id") ON DELETE CASCADE,
  "product_id" uuid NOT NULL,
  "variant_id" text,
  "product_name" text NOT NULL,
  "status" "warranty_claim_status" NOT NULL DEFAULT 'open',
  "reason_code" text,
  "reason" text,
  "comment" text,
  "resolution" text,
  "resolution_note" text,
  "warranty_months" integer,
  "warranty_label" text,
  "covered_until" timestamptz,
  "was_covered" boolean NOT NULL DEFAULT false,
  "external_ref" text,
  "created_by_user_id" text,
  "processed_by_user_id" text,
  "processed_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "warranty_claims_order_idx" ON "warranty_claims" ("order_id");
CREATE INDEX IF NOT EXISTS "warranty_claims_order_item_idx" ON "warranty_claims" ("order_item_id");
CREATE INDEX IF NOT EXISTS "warranty_claims_status_idx" ON "warranty_claims" ("status");
CREATE INDEX IF NOT EXISTS "warranty_claims_created_idx" ON "warranty_claims" ("created_at");
-- One claim per external ERP reference (two-way sync idempotency).
CREATE UNIQUE INDEX IF NOT EXISTS "warranty_claims_external_ref_uniq"
  ON "warranty_claims" ("external_ref") WHERE "external_ref" IS NOT NULL;
