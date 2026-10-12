-- 0045 — Mailing system: send log + queue, automation-flow toggles, campaigns,
-- per-flow idempotency ledger, and a suppression list. All idempotent
-- (IF [NOT] EXISTS / pg_constraint-guarded NOT VALID FKs), per the 0042 pattern,
-- so db:migrate converges identically on a fresh DB and the live DB.

-- ── email_flows: per-automation enable override (DB row beats registry default).
CREATE TABLE IF NOT EXISTS "email_flows" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  "flow_key" text NOT NULL,
  "is_enabled" boolean NOT NULL DEFAULT true,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "email_flows_key_uniq" ON "email_flows" ("flow_key");--> statement-breakpoint

-- ── email_campaigns: admin-composed bulk blasts (the "Manual send" tab).
CREATE TABLE IF NOT EXISTS "email_campaigns" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  "name" text,
  "subject" text NOT NULL,
  "body" text NOT NULL,
  "template_key" text,
  "audience_kind" text NOT NULL,
  "audience_ref" text,
  "audience_addresses" text,
  "status" text NOT NULL DEFAULT 'draft',
  "total_recipients" integer NOT NULL DEFAULT 0,
  "sent_count" integer NOT NULL DEFAULT 0,
  "failed_count" integer NOT NULL DEFAULT 0,
  "created_by" text,
  "started_at" timestamptz,
  "finished_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "deleted_at" timestamptz,
  CONSTRAINT "email_campaigns_audience_chk" CHECK ("audience_kind" IN ('segment','newsletter','marketing_optin','addresses')),
  CONSTRAINT "email_campaigns_status_chk" CHECK ("status" IN ('draft','queued','sending','sent','failed'))
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "email_campaigns_status_idx" ON "email_campaigns" ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "email_campaigns_created_idx" ON "email_campaigns" ("created_at");--> statement-breakpoint

-- ── email_logs: one row per send ATTEMPT — the audit log AND the durable queue.
CREATE TABLE IF NOT EXISTS "email_logs" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  "template_key" text,
  "to_email" text NOT NULL,
  "from_email" text,
  "subject" text,
  "body" text,
  "provider" text,
  "status" text NOT NULL DEFAULT 'pending',
  "error_message" text,
  "provider_message_id" text,
  "category" text,
  "flow_key" text,
  "campaign_id" uuid,
  "attempts" integer NOT NULL DEFAULT 0,
  "max_attempts" integer NOT NULL DEFAULT 3,
  "next_attempt_at" timestamptz,
  "variables" jsonb,
  "metadata" jsonb,
  "sent_at" timestamptz,
  "pinned_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "deleted_at" timestamptz,
  CONSTRAINT "email_logs_status_chk" CHECK ("status" IN ('pending','queued','sent','failed'))
);--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'email_logs_campaign_id_fkey') THEN
    ALTER TABLE "email_logs" ADD CONSTRAINT "email_logs_campaign_id_fkey"
      FOREIGN KEY ("campaign_id") REFERENCES "email_campaigns"("id") ON DELETE SET NULL NOT VALID;
  END IF;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "email_logs_status_next_idx" ON "email_logs" ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "email_logs_created_idx" ON "email_logs" ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "email_logs_category_idx" ON "email_logs" ("category");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "email_logs_campaign_idx" ON "email_logs" ("campaign_id");--> statement-breakpoint
-- Functional lower(to_email) index backing the Logs tab filter-by-email (matches
-- the newsletter lower(email) convention; lives in the migration only).
CREATE INDEX IF NOT EXISTS "email_logs_to_lower_idx" ON "email_logs" (lower("to_email"));--> statement-breakpoint

-- ── mailing_sends: per-(flow, dedup_key) idempotency ledger for automations.
CREATE TABLE IF NOT EXISTS "mailing_sends" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  "flow_key" text NOT NULL,
  "dedup_key" text NOT NULL,
  "customer_profile_id" uuid,
  "created_at" timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "mailing_sends_flow_dedup_uniq" ON "mailing_sends" ("flow_key","dedup_key");--> statement-breakpoint

-- ── email_suppressions: hard bounces / complaints; the marketing gate skips them.
CREATE TABLE IF NOT EXISTS "email_suppressions" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  "email" text NOT NULL,
  "reason" text NOT NULL DEFAULT 'manual',
  "source" text,
  "created_at" timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "email_suppressions_email_uniq" ON "email_suppressions" ("email");
