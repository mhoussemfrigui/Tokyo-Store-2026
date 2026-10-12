-- 0047 — Mailing/newsletter rescan cleanup (audit-driven). Idempotent.
-- Index hygiene + dead-column drops. pg_trgm already enabled by 0037.

CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint

-- (1) email_logs email filter is a leading-wildcard substring LIKE — a plain
-- btree on lower(to_email) (0045) can't serve it. Replace with a trigram GIN.
DROP INDEX IF EXISTS "email_logs_to_lower_idx";--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "email_logs_to_lower_trgm_idx"
  ON "email_logs" USING gin (lower("to_email") gin_trgm_ops);--> statement-breakpoint

-- (2) canSendMarketingTo joins users by lower(email) on the per-row drain path;
-- the only users.email index is a case-sensitive btree. Add a functional one so
-- the equality is sargable instead of a users seq scan.
CREATE INDEX IF NOT EXISTS "users_email_lower_idx" ON "users" (lower("email"));--> statement-breakpoint

-- (3) Marketing-audience resolvers scan WHERE marketing_opt_in AND deleted_at IS
-- NULL with no supporting index. Partial index matches that predicate exactly.
CREATE INDEX IF NOT EXISTS "customer_profiles_marketing_optin_idx"
  ON "customer_profiles" ("marketing_opt_in")
  WHERE "marketing_opt_in" = true AND "deleted_at" IS NULL;--> statement-breakpoint

-- (4) Birthday cron filters by (month, day) of birthday daily. extract() on a
-- date is IMMUTABLE (to_char is not), so this partial functional index serves
-- the lookup instead of a daily full seq-scan. Matches the run.ts predicate.
CREATE INDEX IF NOT EXISTS "customer_profiles_birthday_md_idx"
  ON "customer_profiles" (extract(month from "birthday"), extract(day from "birthday"))
  WHERE "birthday" IS NOT NULL AND "deleted_at" IS NULL AND "marketing_opt_in" = true;--> statement-breakpoint

-- (5) mailing_sends retention sweep deletes WHERE created_at < cutoff; no index.
CREATE INDEX IF NOT EXISTS "mailing_sends_created_idx" ON "mailing_sends" ("created_at");--> statement-breakpoint

-- (6) email_suppressions gate queries lower(email) but the unique index is on the
-- raw column (case-sensitive). Replace with a functional UNIQUE on lower(email):
-- the gate lookup becomes sargable AND case-variant duplicates can't be inserted.
DROP INDEX IF EXISTS "email_suppressions_email_uniq";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "email_suppressions_email_lower_uniq"
  ON "email_suppressions" (lower("email"));--> statement-breakpoint

-- (7) Drop dead columns proven write-never/read-never by the rescan:
--   email_campaigns.sent_count / failed_count → progress is derived from
--     email_logs grouped by campaign_id (no static counters).
--   mailing_sends.customer_profile_id → written only, never read or joined.
ALTER TABLE "email_campaigns" DROP COLUMN IF EXISTS "sent_count";--> statement-breakpoint
ALTER TABLE "email_campaigns" DROP COLUMN IF EXISTS "failed_count";--> statement-breakpoint
ALTER TABLE "mailing_sends" DROP COLUMN IF EXISTS "customer_profile_id";
