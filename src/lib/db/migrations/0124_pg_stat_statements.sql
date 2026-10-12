-- 0124 — create the pg_stat_statements extension where the server preloads it.
--
-- docker-compose.coolify.yml starts Postgres with
-- `shared_preload_libraries=pg_stat_statements` + `pg_stat_statements.track=all`,
-- so the server COLLECTS statement statistics — but no migration ever ran
-- CREATE EXTENSION, so the view never existed: the admin « Requêtes lentes » card
-- (Système → Base de données) stayed « absente » forever in production.
--
-- Guarded so it can never break a deploy:
--   - only when the library is actually preloaded — creating the extension
--     without the preload succeeds but every read of the view then errors
--     (« must be loaded via shared_preload_libraries »), e.g. on the dev /
--     test databases, which don't preload it;
--   - reading shared_preload_libraries needs superuser / pg_read_all_settings,
--     and pg_stat_statements is NOT a trusted extension (superuser to create) —
--     a managed/non-superuser role raises insufficient_privilege, swallowed;
--   - a server image without the contrib module (undefined_file) or that
--     refuses it (feature_not_supported) is skipped the same way.
-- The Coolify compose runs Postgres as POSTGRES_USER (superuser), so the
-- extension is created there on the next boot. Idempotent (IF NOT EXISTS).

DO $$
BEGIN
  IF position('pg_stat_statements' IN coalesce(current_setting('shared_preload_libraries', true), '')) > 0 THEN
    CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
  ELSE
    RAISE NOTICE 'pg_stat_statements not preloaded (shared_preload_libraries) — extension not created';
  END IF;
EXCEPTION
  WHEN insufficient_privilege OR undefined_file OR feature_not_supported THEN
    RAISE NOTICE 'pg_stat_statements not created: %', SQLERRM;
END $$;
