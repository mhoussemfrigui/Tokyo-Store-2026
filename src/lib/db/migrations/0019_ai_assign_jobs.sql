-- AI auto-assignment jobs: background classification of products into existing
-- categories (never created) or brands (created when missing), with a
-- dry-run → review → apply flow. A DEDICATED pair of tables (not import_jobs)
-- so the single-flight gate is scoped per `kind` and the structured proposals
-- have a home. Idempotent (CREATE ... IF NOT EXISTS), uuid_generate_v7() PKs.
--
-- ai_assign_jobs — one row per run (dry_run or apply).
CREATE TABLE IF NOT EXISTS "ai_assign_jobs" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
  "kind" text NOT NULL,
  "phase" text DEFAULT 'dry_run' NOT NULL,
  "status" text DEFAULT 'queued' NOT NULL,
  "scope" text DEFAULT 'unassigned' NOT NULL,
  "existing_policy" text DEFAULT 'skip' NOT NULL,
  "processed" integer DEFAULT 0 NOT NULL,
  "total" integer DEFAULT 0 NOT NULL,
  "applied_count" integer DEFAULT 0 NOT NULL,
  "summary" jsonb,
  "source_job_id" uuid,
  "error" text,
  "created_by" text,
  "started_at" timestamp with time zone,
  "finished_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "ai_assign_jobs_kind_chk" CHECK ("kind" IN ('categorize','brands')),
  CONSTRAINT "ai_assign_jobs_phase_chk" CHECK ("phase" IN ('dry_run','apply')),
  CONSTRAINT "ai_assign_jobs_status_chk" CHECK ("status" IN ('queued','running','completed','failed')),
  CONSTRAINT "ai_assign_jobs_scope_chk" CHECK ("scope" IN ('all','unassigned')),
  CONSTRAINT "ai_assign_jobs_policy_chk" CHECK ("existing_policy" IN ('skip','suggest','overwrite'))
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_assign_jobs_kind_status_idx" ON "ai_assign_jobs" ("kind","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_assign_jobs_created_idx" ON "ai_assign_jobs" ("created_at" DESC);--> statement-breakpoint
-- Single-flight backstop: at most ONE non-terminal job per kind, so a
-- check-then-insert race (double-click / second tab) trips this on INSERT
-- rather than launching a duplicate background run.
CREATE UNIQUE INDEX IF NOT EXISTS "ai_assign_jobs_one_active_per_kind"
  ON "ai_assign_jobs" ("kind") WHERE "status" IN ('queued','running');--> statement-breakpoint
-- ai_assign_proposals — one row per product the dry-run looked at.
CREATE TABLE IF NOT EXISTS "ai_assign_proposals" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
  "job_id" uuid NOT NULL,
  "product_id" uuid NOT NULL,
  "product_name" text NOT NULL,
  "product_slug" text,
  "action" text NOT NULL,
  "skip_reason" text,
  "current_summary" text,
  "proposed" jsonb,
  "confidence" integer,
  "reason" text,
  "selected" boolean DEFAULT true NOT NULL,
  "applied" boolean DEFAULT false NOT NULL,
  "apply_error" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "ai_assign_proposals_action_chk" CHECK ("action" IN ('assign','reassign','skip','no_match','error'))
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_assign_proposals_job_idx" ON "ai_assign_proposals" ("job_id");
