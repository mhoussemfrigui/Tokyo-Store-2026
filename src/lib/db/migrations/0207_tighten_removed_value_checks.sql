-- 0207 — Complete the B2B + merchandising-Collections removal at the DB-constraint
-- level. 0204 dropped the feature tables but left two CHECK constraints (and any
-- legacy rows) still admitting removed values:
--   • promotion_targets.target_type still allowed 'business'. coupon-eligibility now
--     resolves customer/segment targets ONLY, so a promotion whose sole targeting was
--     a 'business' row would be read as HAVING NO targets and silently become PUBLIC.
--     Purge any such rows, then narrow the CHECK to the two surviving target types.
--   • catalog_content_gen_jobs.entity_type still allowed 'collection' (merchandising
--     collections are gone; ContentGenEntityType is category|brand). Purge + narrow.
-- Forward migration, idempotent (DELETE is naturally idempotent; constraint is
-- dropped IF EXISTS before being re-added in its tightened form).
DELETE FROM "promotion_targets" WHERE "target_type" = 'business';--> statement-breakpoint
ALTER TABLE "promotion_targets" DROP CONSTRAINT IF EXISTS "promotion_targets_type_chk";--> statement-breakpoint
ALTER TABLE "promotion_targets" ADD CONSTRAINT "promotion_targets_type_chk" CHECK ("target_type" IN ('customer', 'segment'));--> statement-breakpoint
DELETE FROM "catalog_content_gen_jobs" WHERE "entity_type" = 'collection';--> statement-breakpoint
ALTER TABLE "catalog_content_gen_jobs" DROP CONSTRAINT IF EXISTS "catalog_content_gen_jobs_entity_type_chk";--> statement-breakpoint
ALTER TABLE "catalog_content_gen_jobs" ADD CONSTRAINT "catalog_content_gen_jobs_entity_type_chk" CHECK ("entity_type" IN ('category', 'brand'));
