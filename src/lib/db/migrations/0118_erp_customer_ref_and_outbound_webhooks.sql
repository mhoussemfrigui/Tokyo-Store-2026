-- 0118 — ERP integration foundations: customer external_ref + outbound webhooks.
--
-- (a) customer_profiles.external_ref — the two-way ERP link for customers, the
--     same pattern products/orders already carry (partial-unique over the LIVE
--     set so a soft-deleted customer's ref can be reused). Plus an updated_at
--     index so the /api/customers incremental sync is an index range scan, not a
--     seq scan (mirrors orders_updated_at_idx from 0055).
-- (b) webhook_endpoints + webhook_deliveries — the OUTBOUND webhook subsystem
--     (distinct from the inbound payment `webhook_events`). Endpoints hold the
--     ENCRYPTED per-endpoint signing secret; deliveries are the durable retrying
--     queue (modeled on email_logs) the cron drain works.
--
-- Additive-only + idempotent (IF NOT EXISTS / IF EXISTS guards).

ALTER TABLE "customer_profiles" ADD COLUMN IF NOT EXISTS "external_ref" text;
--> statement-breakpoint
-- Partial-unique over live rows only (a soft-deleted profile frees its ref).
CREATE UNIQUE INDEX IF NOT EXISTS "customer_profiles_external_ref_uniq"
  ON "customer_profiles" ("external_ref")
  WHERE "external_ref" IS NOT NULL AND "deleted_at" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "customer_profiles_updated_at_idx"
  ON "customer_profiles" ("updated_at");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "webhook_endpoints" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
  "name" text NOT NULL,
  "url" text NOT NULL,
  "secret_enc" text NOT NULL,
  "prefix" text NOT NULL,
  "event_types" text[] DEFAULT '{}' NOT NULL,
  "is_active" boolean DEFAULT true NOT NULL,
  "description" text,
  "created_by" text,
  "revoked_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "webhook_endpoints_active_idx"
  ON "webhook_endpoints" ("revoked_at");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "webhook_deliveries" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
  "endpoint_id" uuid NOT NULL,
  "event_name" text NOT NULL,
  "payload" jsonb NOT NULL,
  "status" text DEFAULT 'queued' NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "max_attempts" integer DEFAULT 5 NOT NULL,
  "next_attempt_at" timestamptz DEFAULT now() NOT NULL,
  "response_status" integer,
  "error_message" text,
  "delivered_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- Real FK (same module): dropping an endpoint reaps its delivery rows.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'webhook_deliveries_endpoint_id_fk'
  ) THEN
    ALTER TABLE "webhook_deliveries"
      ADD CONSTRAINT "webhook_deliveries_endpoint_id_fk"
      FOREIGN KEY ("endpoint_id") REFERENCES "webhook_endpoints" ("id") ON DELETE CASCADE;
  END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "webhook_deliveries_status_next_idx"
  ON "webhook_deliveries" ("status", "next_attempt_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "webhook_deliveries_endpoint_idx"
  ON "webhook_deliveries" ("endpoint_id", "created_at");
