-- Scheduled/cron job execution history — one row per actual run of any
-- registered job (review-generation scheduler, retention purge, future mailing).
-- Powers the admin "Tâches planifiées" dashboard. Bounded per job_key by an
-- app-side prune-on-record. Idempotent.
CREATE TABLE IF NOT EXISTS "job_run_log" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
  "job_key" text NOT NULL,
  "status" text NOT NULL,
  "trigger" text NOT NULL DEFAULT 'schedule',
  "started_at" timestamp with time zone NOT NULL,
  "finished_at" timestamp with time zone,
  "duration_ms" integer,
  "summary" text,
  "error" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "job_run_log_status_chk" CHECK ("status" IN ('ok','failed','skipped')),
  CONSTRAINT "job_run_log_trigger_chk" CHECK ("trigger" IN ('schedule','manual','cron'))
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "job_run_log_job_created_idx" ON "job_run_log" ("job_key","created_at" DESC);
