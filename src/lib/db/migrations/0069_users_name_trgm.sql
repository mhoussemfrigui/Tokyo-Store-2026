-- Admin Utilisateurs name-search performance.
--
-- AuthService.list (src/modules/auth/service.ts) matches a leading-wildcard
-- ILIKE across email AND name:
--   or(ilike(users.email,'%q%'), ilike(users.name,'%q%'))
-- `users.email` already has a trigram GIN (users_email_trgm), but `users.name`
-- had none — so the OR forced a Seq Scan on every Utilisateurs search. Mirrors
-- the orders 0067 fix. Both predicates are on the same table, so the planner can
-- BitmapOr the two GIN indexes once name is indexed too.
--
-- pg_trgm is enabled in the baseline. `users.name` is NOT NULL (Better Auth),
-- so no partial predicate is needed. NOT CONCURRENTLY: the drizzle migrator
-- wraps the batch in one transaction, and CREATE INDEX CONCURRENTLY cannot run
-- inside a transaction block.
CREATE INDEX IF NOT EXISTS "users_name_trgm"
  ON "users" USING gin ("name" gin_trgm_ops);
