-- Journal d'audit upgrade: per-row severity + index reconciliation.
--
-- 1) severity column (debug|info|warn|error) written at insert from
--    severityFor(event_name) (src/events/severity.ts). DEFAULT 'info' backfills
--    every existing row in one cheap metadata-only statement; new rows get the
--    real classification. Drives the new "Sévérité" filter + KPI counts.
ALTER TABLE "audit_log" ADD COLUMN IF NOT EXISTS "severity" text NOT NULL DEFAULT 'info';--> statement-breakpoint

-- 2) Reconcile indexes on the hottest-insert table. The squash baseline carried
--    redundant single-column btrees (shadowed by the composites), an ASC
--    created_at btree (the DESC one + the BRIN cover every real query), and an
--    unused metadata GIN (no code path queries metadata as a predicate) — all
--    pure write-amplification. Drop them; keep BRIN (purge range) + the DESC
--    created_at btree (purge ORDER BY) + the (col, id DESC) composites below.
DROP INDEX IF EXISTS "audit_event_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "audit_actor_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "audit_created_at_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "audit_metadata_gin";--> statement-breakpoint

-- 3) Filter composites keyed on (col, id DESC). The admin Journal keysets on
--    `id` (uuid v7 = newest-first, EXACT — created_at is microsecond-precision
--    but a JS/ISO cursor is millisecond, so it can't be an exact boundary). The
--    composites therefore lead with the filter column + id DESC so a
--    severity/actor/event-filtered page is an index range-scan in keyset order,
--    not a Sort. Recreate the baseline event composite (was created_at DESC) to
--    match.
DROP INDEX IF EXISTS "audit_event_recent_idx";--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_event_recent_idx" ON "audit_log" USING btree ("event_name","id" DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_actor_recent_idx" ON "audit_log" USING btree ("actor_user_id","id" DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_severity_recent_idx" ON "audit_log" USING btree ("severity","id" DESC);--> statement-breakpoint

-- 4) Replace the single-column created_at DESC btree with a (created_at DESC,
--    id DESC) composite. It still drives the retention purge's ORDER BY
--    created_at AND serves the date-range Journal filter (created_at BETWEEN …
--    ORDER BY id DESC) so a date-only filter range-scans the window instead of
--    a backward full PK scan. BRIN stays the bulk-range companion for purge.
DROP INDEX IF EXISTS "audit_created_at_desc_idx";--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_created_id_idx" ON "audit_log" USING btree ("created_at" DESC,"id" DESC);
