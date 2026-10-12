-- 0046 — Mailing perf + integrity follow-up (audit-driven). Idempotent.

-- (1) VALIDATE the email_logs → email_campaigns FK 0045 added NOT VALID (the
-- 0040→0041 pattern). The table is freshly created, so validation is free and
-- lets the planner trust the FK.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'email_logs_campaign_id_fkey' AND NOT convalidated) THEN
    ALTER TABLE "email_logs" VALIDATE CONSTRAINT "email_logs_campaign_id_fkey";
  END IF;
END $$;--> statement-breakpoint

-- (2) Serve the daily review-request cron's window scan
-- (WHERE status='delivered' AND updated_at BETWEEN …) — otherwise a seq scan of
-- the whole orders table once a day. Composite (status, updated_at).
CREATE INDEX IF NOT EXISTS "orders_status_updated_idx" ON "orders" ("status","updated_at");
