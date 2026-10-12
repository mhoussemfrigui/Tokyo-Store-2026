-- Final cleanup (DB-DRIFT-1 + DB-IDX-1). All idempotent (IF EXISTS): a no-op on
-- the live DB where these already happened, a real change on a fresh DB — so
-- `db:migrate` on an empty DB converges to the same shape as the live DB.

-- DB-DRIFT-1 — the deferred dead-column drops (the RC-1 follow-up). 0035 was
-- neutralized to avoid a rolling-deploy overlap window; the epic is now live
-- everywhere and NO running code references these columns (the Drizzle schemas
-- omit them, so `.select()` never names them), so dropping is safe now.
ALTER TABLE "customer_profiles" DROP COLUMN IF EXISTS "date_of_birth";--> statement-breakpoint
ALTER TABLE "coin_levels" DROP COLUMN IF EXISTS "badge_color";--> statement-breakpoint
ALTER TABLE "promotions" DROP COLUMN IF EXISTS "description";--> statement-breakpoint

-- DB-IDX-1 — drop redundant overlapping indexes on `orders`. Each is fully
-- covered by a sibling that the planner already prefers (EXPLAIN-verified), so
-- they only add INSERT/UPDATE write cost. The dominating siblings
-- (orders_status_recent_idx, orders_user_recent_idx, orders_contact_phone_norm_idx)
-- are confirmed present and are kept.
DROP INDEX IF EXISTS "orders_contact_phone_digits_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "orders_status_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "orders_user_created_idx";
