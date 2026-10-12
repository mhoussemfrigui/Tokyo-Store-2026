-- 0134 — Index hygiene + $type<Union> CHECK constraints (audit).
--
-- (1) categories.boutique_image_media_id got a reverse-lookup partial index like
--     every other category media soft-link (hero/og/icon) — the media orphan /
--     reference queries scan it, so without one they seq-scan categories.
-- (2) stock_transfers_order_idx made PARTIAL — order_id is a mostly-NULL soft
--     link (only order-driven transfers carry one) and the only query filters by
--     it, so a full index just bloats writes on the common (manual) transfer.
-- (3) Dropped the redundant cul_user_idx / cul_profile_idx — cul_user_unique /
--     cul_profile_unique already index those columns (0125/0126 pruned this exact
--     duplicate-of-unique anti-pattern on other tables but missed this one).
-- (4) Added the SQL CHECK the architecture rule mandates for stable $type<Union>
--     columns (the "extend the CHECK with the union or hit runtime 23514"
--     contract). import_jobs.segment is deliberately left open (0100) — its
--     segment set is more fluid — and stays uncovered by design.
-- All additive/idempotent; the CHECKs match the current union values, which the
-- app is the only writer of, so they apply cleanly to existing rows.

CREATE INDEX IF NOT EXISTS "categories_boutique_image_media_id_idx"
  ON "categories" ("boutique_image_media_id") WHERE "boutique_image_media_id" IS NOT NULL;

DROP INDEX IF EXISTS "stock_transfers_order_idx";
CREATE INDEX IF NOT EXISTS "stock_transfers_order_idx"
  ON "stock_transfers" ("order_id") WHERE "order_id" IS NOT NULL;

DROP INDEX IF EXISTS "cul_user_idx";
DROP INDEX IF EXISTS "cul_profile_idx";

DO $$ BEGIN
  ALTER TABLE "ai_job_logs" ADD CONSTRAINT "ai_job_logs_job_kind_chk"
    CHECK ("job_kind" IN ('product_gen', 'review_gen', 'auto_assign', 'content_gen'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "ai_job_logs" ADD CONSTRAINT "ai_job_logs_level_chk"
    CHECK ("level" IN ('info', 'warn', 'error'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "ai_call_logs" ADD CONSTRAINT "ai_call_logs_status_chk"
    CHECK ("status" IN ('ok', 'empty', 'error'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "search_aliases" ADD CONSTRAINT "search_aliases_source_chk"
    CHECK ("source" IN ('manual', 'default'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "currencies" ADD CONSTRAINT "currencies_symbol_position_chk"
    CHECK ("symbol_position" IN ('before', 'after'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
