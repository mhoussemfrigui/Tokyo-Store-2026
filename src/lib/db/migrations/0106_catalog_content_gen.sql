-- 0106 — Bulk catalog-entity content generation (AI).
--
-- A GENERALIZED twin of the product generator (migration 0064) for the catalog
-- ENTITIES — categories, brands and collections — sharing one job/draft model via
-- an `entity_type` discriminator instead of three table sets. An admin starts a
-- scoped run for one entity type, the detached runner generates the selected
-- content fields per entity into DRAFT rows, the admin reviews/selects, then
-- applies — drafts written back onto the entity rows. Purely additive; idempotent
-- + safe to re-run.

CREATE TABLE IF NOT EXISTS "catalog_content_gen_jobs" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  "status" text NOT NULL DEFAULT 'queued',
  "entity_type" text NOT NULL,
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
  ALTER TABLE "catalog_content_gen_jobs" ADD CONSTRAINT "catalog_content_gen_jobs_status_chk"
    CHECK ("status" IN ('queued', 'running', 'completed', 'failed'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "catalog_content_gen_jobs" ADD CONSTRAINT "catalog_content_gen_jobs_entity_type_chk"
    CHECK ("entity_type" IN ('category', 'brand', 'collection'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS "catalog_content_gen_jobs_status_idx" ON "catalog_content_gen_jobs" ("status");
CREATE INDEX IF NOT EXISTS "catalog_content_gen_jobs_created_idx" ON "catalog_content_gen_jobs" ("created_at" DESC);

-- At most ONE active (queued/running) job PER ENTITY TYPE at a time — the
-- per-entity-type single-flight gate the service's hasActive(entityType) check
-- backs up. Partial unique on the entity_type column itself (so one category run
-- and one brand run can coexist, but never two category runs).
CREATE UNIQUE INDEX IF NOT EXISTS "catalog_content_gen_jobs_one_active"
  ON "catalog_content_gen_jobs" ("entity_type") WHERE "status" IN ('queued', 'running');

CREATE TABLE IF NOT EXISTS "catalog_content_gen_drafts" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  "job_id" uuid NOT NULL,
  "entity_id" uuid NOT NULL,
  "entity_name" text NOT NULL,
  -- Generated content: { description?, editorial?, faqs?:[{question,answer}],
  -- metaTitle?, metaDescription? }. Only the fields the run targeted are set.
  "generated" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "selected" boolean NOT NULL DEFAULT true,
  "applied" boolean NOT NULL DEFAULT false,
  "apply_error" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

-- Composite to serve listDrafts's WHERE job_id + ORDER BY (entity_name,
-- created_at) without a sort (mirrors product_generation_drafts_job_idx); also
-- serves plain job_id lookups + the FK.
CREATE INDEX IF NOT EXISTS "catalog_content_gen_drafts_job_idx"
  ON "catalog_content_gen_drafts" ("job_id", "entity_name", "created_at");

-- Real FK with ON DELETE CASCADE so deleting a job removes its drafts
-- automatically (mirrors product_generation_drafts_job_id_fk).
DO $$ BEGIN
  ALTER TABLE "catalog_content_gen_drafts"
    ADD CONSTRAINT "catalog_content_gen_drafts_job_id_fk"
    FOREIGN KEY ("job_id") REFERENCES "catalog_content_gen_jobs"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
