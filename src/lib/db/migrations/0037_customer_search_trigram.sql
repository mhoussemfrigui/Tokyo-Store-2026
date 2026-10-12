-- Clients search performance (DB-1, DB-3).
--
-- searchCustomersForAdmin matches a leading-wildcard ILIKE on first_name /
-- last_name / phone_normalized (customer_profiles) and email (users) — none of
-- which a plain btree can serve, so it seq-scanned. The other big search
-- surfaces (products/brands/media/blog) already have trigram GIN indexes; the
-- customer tables were the gap. pg_trgm is enabled in the baseline.
--
-- NOTE: these indexes are only USED once the query keeps each predicate on its
-- own table. The email match is resolved by a separate users scan (this file's
-- users_email_trgm) → profile ids, and the customer_profiles OR
-- (first_name/last_name/phone_normalized) then BitmapOrs the three GIN indexes
-- below. Mixing the joined users.email column into the same disjunction would
-- force a post-join seq scan and defeat them — see searchCustomersForAdmin
-- (src/associations/customer-user.service.ts), restructured for exactly this.
--
-- Partial on the live set (matches the query's soft-delete filter) for the
-- profile columns; users.email has no soft-delete column so it's unpartitioned.
-- The phone_normalized trigram makes the substring phone match sargable too
-- (the existing btree only served the equality/prefix guest-link path).
-- NOT CONCURRENTLY: the drizzle migrator wraps the batch in one transaction,
-- and CREATE INDEX CONCURRENTLY cannot run inside a transaction block.
CREATE INDEX IF NOT EXISTS "customer_profiles_first_name_trgm"
  ON "customer_profiles" USING gin ("first_name" gin_trgm_ops)
  WHERE "deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "customer_profiles_last_name_trgm"
  ON "customer_profiles" USING gin ("last_name" gin_trgm_ops)
  WHERE "deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "customer_profiles_phone_norm_trgm"
  ON "customer_profiles" USING gin ("phone_normalized" gin_trgm_ops)
  WHERE "phone_normalized" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "users_email_trgm"
  ON "users" USING gin ("email" gin_trgm_ops);
