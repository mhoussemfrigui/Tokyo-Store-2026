-- Per-item log feed for AI generation jobs (product-gen / review-gen /
-- auto-assign). Today a job carries only a single `error` string + swallowed
-- per-item catches, so an operator sees a thin result with no "why". This is a
-- shared, append-only log keyed by (job_kind, job_id) — one row per meaningful
-- per-item outcome (generated / skipped / provider error / parse error). The
-- runners write best-effort; the admin panels read it beside the progress bar.
-- Bounded: runners cap rows per job + the per-job-table pruneOld cascade removes
-- a job's logs when the job is pruned (FK-less soft link; pruned by age here too).
CREATE TABLE IF NOT EXISTS "ai_job_logs" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  "job_kind" text NOT NULL,
  "job_id" uuid NOT NULL,
  "level" text NOT NULL DEFAULT 'info',
  "step" text NOT NULL,
  "message" text,
  "item_ref" text,
  "created_at" timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_job_logs_job_idx" ON "ai_job_logs" USING btree ("job_kind", "job_id", "created_at", "id");
