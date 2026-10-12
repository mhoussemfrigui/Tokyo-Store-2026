-- Composite indexes matching the ORDER BY of the three AI review/draft list
-- queries. Each list filters by job_id then sorts; the prior single-column
-- (job_id) index served the filter but forced an in-memory sort on every poll of
-- the admin review panel (a whole-catalogue dry-run can produce up to ~1000-2000
-- rows). Extending the index with the sort columns lets Postgres return rows
-- pre-ordered. The composite also still serves the plain job_id lookups, so the
-- old single-column index is redundant and dropped.

-- product_generation_drafts: ORDER BY (product_name, created_at) ASC
DROP INDEX IF EXISTS "product_generation_drafts_job_idx";--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "product_generation_drafts_job_idx"
  ON "product_generation_drafts" USING btree ("job_id", "product_name", "created_at");--> statement-breakpoint

-- review_generation_drafts: ORDER BY (product_name, created_at) ASC
DROP INDEX IF EXISTS "review_generation_drafts_job_idx";--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "review_generation_drafts_job_idx"
  ON "review_generation_drafts" USING btree ("job_id", "product_name", "created_at");--> statement-breakpoint

-- ai_assign_proposals: ORDER BY (confidence DESC, created_at DESC)
DROP INDEX IF EXISTS "ai_assign_proposals_job_idx";--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_assign_proposals_job_idx"
  ON "ai_assign_proposals" USING btree ("job_id", "confidence" DESC, "created_at" DESC);
