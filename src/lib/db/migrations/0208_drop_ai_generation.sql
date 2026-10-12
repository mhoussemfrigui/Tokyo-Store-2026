-- 0208 — Remove the AI *generation* features entirely: product generation,
-- catalogue content generation, AI auto-assignment (attributes/categories), the
-- shared AI job-log sink, and automated review generation + its schedule. This
-- is a forward DROP migration (the app code for all of these is deleted).
-- Idempotent (IF EXISTS / CASCADE) so a partial apply can be re-run; CASCADE
-- clears the intra-feature FKs (drafts/proposals → jobs).
--
-- KEPT (NOT dropped here): semantic search is part of SEARCH, not generation —
-- its `ai_call_logs` (transport log, retention-pruned) and `ai_provider_settings`
-- (provider/model config, also powering embeddings) remain. Only the generation
-- job/draft/proposal/schedule tables and the generic `ai_job_logs` sink go.

-- ── Children first (drafts/proposals), then their parent job tables. CASCADE is
--    belt-and-braces for the FKs listed above.
DROP TABLE IF EXISTS "product_generation_drafts" CASCADE;
DROP TABLE IF EXISTS "product_generation_jobs" CASCADE;
DROP TABLE IF EXISTS "catalog_content_gen_drafts" CASCADE;
DROP TABLE IF EXISTS "catalog_content_gen_jobs" CASCADE;
DROP TABLE IF EXISTS "ai_assign_proposals" CASCADE;
DROP TABLE IF EXISTS "ai_assign_jobs" CASCADE;
DROP TABLE IF EXISTS "review_generation_drafts" CASCADE;
DROP TABLE IF EXISTS "review_generation_jobs" CASCADE;
DROP TABLE IF EXISTS "review_schedule" CASCADE;

-- ── The generic AI job-log sink (progress/trace rows for the generation jobs).
--    Distinct from `ai_call_logs` (semantic-search transport log) which stays.
DROP TABLE IF EXISTS "ai_job_logs" CASCADE;
