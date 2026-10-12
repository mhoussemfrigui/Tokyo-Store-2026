-- Allow the AI auto-assignment jobs to target the new "attributes" kind
-- (bulk attribute attribution), alongside the existing categorize / brands.
-- The kind column is plain text; only this CHECK constraint gated the set.
-- Idempotent: drop-if-exists then re-add with the widened allow-list.
ALTER TABLE "ai_assign_jobs" DROP CONSTRAINT IF EXISTS "ai_assign_jobs_kind_chk";--> statement-breakpoint
ALTER TABLE "ai_assign_jobs"
  ADD CONSTRAINT "ai_assign_jobs_kind_chk" CHECK ("kind" IN ('categorize','brands','attributes'));
