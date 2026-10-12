-- Avis: review origin marker + AI generation jobs/drafts + internal schedule.
-- Idempotent (ADD COLUMN / CREATE TABLE / CREATE INDEX IF NOT EXISTS; CHECK + FK
-- via DROP-IF-EXISTS then ADD, mirroring 0021/0022).

-- 1. product_reviews.source — distinguishes customer | manual (admin) | ai.
ALTER TABLE "product_reviews" ADD COLUMN IF NOT EXISTS "source" text NOT NULL DEFAULT 'customer';--> statement-breakpoint
ALTER TABLE "product_reviews" DROP CONSTRAINT IF EXISTS "product_reviews_source_chk";--> statement-breakpoint
ALTER TABLE "product_reviews" ADD CONSTRAINT "product_reviews_source_chk" CHECK ("source" IN ('customer','manual','ai'));--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "product_reviews_source_idx" ON "product_reviews" ("source");--> statement-breakpoint

-- 2. review_generation_jobs — one row per bulk/scheduled generation run.
CREATE TABLE IF NOT EXISTS "review_generation_jobs" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
  "status" text NOT NULL DEFAULT 'queued',
  "scope" jsonb NOT NULL,
  "settings" jsonb NOT NULL,
  "scheduled" boolean NOT NULL DEFAULT false,
  "processed" integer NOT NULL DEFAULT 0,
  "total" integer NOT NULL DEFAULT 0,
  "generated" integer NOT NULL DEFAULT 0,
  "inserted" integer NOT NULL DEFAULT 0,
  "error" text,
  "created_by" text,
  "started_at" timestamp with time zone,
  "finished_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "review_generation_jobs_status_chk" CHECK ("status" IN ('queued','running','completed','failed'))
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "review_generation_jobs_status_idx" ON "review_generation_jobs" ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "review_generation_jobs_created_idx" ON "review_generation_jobs" ("created_at" DESC);--> statement-breakpoint

-- 3. review_generation_drafts — one row per generated (not-yet-applied) review.
CREATE TABLE IF NOT EXISTS "review_generation_drafts" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
  "job_id" uuid NOT NULL,
  "product_id" uuid NOT NULL,
  "product_name" text NOT NULL,
  "author_name" text NOT NULL,
  "rating" integer NOT NULL,
  "title" text NOT NULL,
  "body" text NOT NULL,
  "lang" text NOT NULL DEFAULT 'fr',
  "selected" boolean NOT NULL DEFAULT true,
  "applied" boolean NOT NULL DEFAULT false,
  "apply_error" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "review_generation_drafts_rating_range" CHECK ("rating" >= 1 AND "rating" <= 5)
);--> statement-breakpoint
ALTER TABLE "review_generation_drafts" DROP CONSTRAINT IF EXISTS "review_generation_drafts_job_fkey";--> statement-breakpoint
ALTER TABLE "review_generation_drafts" ADD CONSTRAINT "review_generation_drafts_job_fkey"
  FOREIGN KEY ("job_id") REFERENCES "review_generation_jobs"("id") ON DELETE CASCADE;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "review_generation_drafts_job_idx" ON "review_generation_drafts" ("job_id");--> statement-breakpoint

-- 4. review_schedule — single-row config + run-state for the internal scheduler.
CREATE TABLE IF NOT EXISTS "review_schedule" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
  "enabled" boolean NOT NULL DEFAULT false,
  "cadence_hours" integer NOT NULL DEFAULT 72,
  "max_products_per_run" integer NOT NULL DEFAULT 8,
  "scope" jsonb NOT NULL,
  "settings" jsonb NOT NULL,
  "last_run_at" timestamp with time zone,
  "next_run_at" timestamp with time zone,
  "last_error" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
