-- 0117 — server-side connection-timeout defaults on the application role.
--
-- src/lib/db/client.ts applies `lock_timeout` and
-- `idle_in_transaction_session_timeout` only as libpq STARTUP parameters (the
-- `options` packet). On the default DIRECT connection Postgres honours them, but
-- on the supported opt-in PgBouncer TRANSACTION-mode path those startup params
-- are dropped (`IGNORE_STARTUP_PARAMETERS`), and — unlike statement_timeout,
-- which node-postgres also enforces client-side via `query_timeout` regardless
-- of pooling — these two have NO client-side equivalent. So a stuck transaction
-- would hold its locks/server slot indefinitely, and lock waits would never
-- abort, exactly on the documented scaling path.
--
-- ALTER ROLE … SET makes the defaults SERVER-SIDE: Postgres applies them when it
-- opens a backend for this role, so they survive PgBouncer (which multiplexes
-- onto those backends). `CURRENT_USER` targets the app role this migration
-- connects as (same DATABASE_URL as the runtime). Both params are USERSET, so a
-- non-superuser role may set them on itself. statement_timeout is intentionally
-- NOT set here (client `query_timeout` covers the app, and a role-level cap would
-- also throttle long seeds/benches/migrations run under this role).
--
-- Idempotent: ALTER ROLE … SET just re-asserts the same value on re-run.
-- NOTE: if you ever split the migration role from the runtime role, re-point
-- this at the runtime role.

ALTER ROLE CURRENT_USER SET lock_timeout = '3s';
--> statement-breakpoint
ALTER ROLE CURRENT_USER SET idle_in_transaction_session_timeout = '30s';
