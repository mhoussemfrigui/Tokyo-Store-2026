-- Partial index backing the retention purge of ephemeral quick-buy carts
-- (cartService.purgeEphemeralOlderThan / the /api/cron/retention sweep).
--
-- Without it, `DELETE FROM carts WHERE token LIKE 'qb-%' AND created_at < cutoff`
-- seq-scans the entire carts table (one row per anonymous storefront visitor),
-- which on a large store exceeds the pool's 10s statement_timeout and the cron
-- retries forever. This index lets the batched purge run an index scan over only
-- the ephemeral carts, ordered by created_at. The `token LIKE 'qb-%'` predicate
-- is IMMUTABLE (valid in a partial-index WHERE) and keeps the index tiny by
-- excluding all non-ephemeral carts. Idempotent.
CREATE INDEX IF NOT EXISTS "carts_ephemeral_purge_idx"
  ON "carts" ("created_at")
  WHERE "token" LIKE 'qb-%';
