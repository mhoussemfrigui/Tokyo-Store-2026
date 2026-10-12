-- ai_assign_proposals.job_id had NO foreign key (migration 0019 declared it a
-- bare `uuid NOT NULL`), so deleting a job — or the new aiAssignJobService.pruneOld
-- sweep — would ORPHAN its proposal rows (one per scanned product, potentially
-- thousands per whole-catalogue dry-run). Add the FK with ON DELETE CASCADE so
-- proposals are reaped with their job, matching the review-generation drafts→jobs
-- cascade (0023). Idempotent: drop-then-add. Safe because proposals are only ever
-- inserted with a live job_id (no pre-existing orphans).
ALTER TABLE "ai_assign_proposals" DROP CONSTRAINT IF EXISTS "ai_assign_proposals_job_fkey";--> statement-breakpoint
ALTER TABLE "ai_assign_proposals"
  ADD CONSTRAINT "ai_assign_proposals_job_fkey"
  FOREIGN KEY ("job_id") REFERENCES "ai_assign_jobs"("id") ON DELETE CASCADE;
