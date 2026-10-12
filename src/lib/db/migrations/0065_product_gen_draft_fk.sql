-- 0065 — FK CASCADE for product_generation_drafts.job_id.
--
-- 0064 created the drafts table without a foreign key (pruneOld deleted drafts
-- manually first). Match the review_generation_drafts pattern: a real FK with
-- ON DELETE CASCADE so deleting a job removes its drafts automatically and the
-- DB enforces referential integrity (no orphan drafts if a manual delete races
-- or half-fails). Idempotent.

DO $$ BEGIN
  ALTER TABLE "product_generation_drafts"
    ADD CONSTRAINT "product_generation_drafts_job_id_fk"
    FOREIGN KEY ("job_id") REFERENCES "product_generation_jobs"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
