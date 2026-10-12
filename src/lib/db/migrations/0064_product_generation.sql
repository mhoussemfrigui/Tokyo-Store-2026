-- 0064 — Bulk product content generation (AI).
--
-- Mirrors the review-generation job/draft model (migration set for reviews) for
-- PRODUCTS: an admin starts a scoped run (catalogue / category / brand), the
-- detached runner generates the selected content fields per product into DRAFT
-- rows, the admin reviews/selects, then applies — drafts are written back onto
-- the products. Purely additive; idempotent + safe to re-run.

CREATE TABLE IF NOT EXISTS "product_generation_jobs" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  "status" text NOT NULL DEFAULT 'queued',
  "scope" jsonb NOT NULL,
  "settings" jsonb NOT NULL,
  "processed" integer NOT NULL DEFAULT 0,
  "total" integer NOT NULL DEFAULT 0,
  "generated" integer NOT NULL DEFAULT 0,
  "inserted" integer NOT NULL DEFAULT 0,
  "error" text,
  "created_by" text,
  "started_at" timestamptz,
  "finished_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

DO $$ BEGIN
  ALTER TABLE "product_generation_jobs" ADD CONSTRAINT "product_generation_jobs_status_chk"
    CHECK ("status" IN ('queued', 'running', 'completed', 'failed'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS "product_generation_jobs_status_idx" ON "product_generation_jobs" ("status");
CREATE INDEX IF NOT EXISTS "product_generation_jobs_created_idx" ON "product_generation_jobs" ("created_at" DESC);

-- At most ONE active (queued/running) job at a time — the single-flight gate the
-- service's hasActive() check backs up. Partial unique on a constant expression.
CREATE UNIQUE INDEX IF NOT EXISTS "product_generation_jobs_one_active"
  ON "product_generation_jobs" ((1)) WHERE "status" IN ('queued', 'running');

CREATE TABLE IF NOT EXISTS "product_generation_drafts" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  "job_id" uuid NOT NULL,
  "product_id" uuid NOT NULL,
  "product_name" text NOT NULL,
  -- Generated content: { shortDesc?, description?, highlights?:string[],
  -- metaTitle?, metaDescription? }. Only the fields the run targeted are set.
  "generated" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "selected" boolean NOT NULL DEFAULT true,
  "applied" boolean NOT NULL DEFAULT false,
  "apply_error" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "product_generation_drafts_job_idx" ON "product_generation_drafts" ("job_id");
