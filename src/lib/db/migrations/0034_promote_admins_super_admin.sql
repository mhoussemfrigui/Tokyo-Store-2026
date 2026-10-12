-- Phase 2 — promote existing enum admins to the super_admin RBAC role.
--
-- Every users.role='admin' already resolves to the '*' wildcard via the
-- authorize engine's legacy bridge, so this changes NO access. It makes the
-- role model reflect reality — populating user_roles on an existing-DB upgrade
-- so the enum bridge can eventually be retired, and so the admin panel's role
-- views show the seeded admins as super_admins.
--
-- All admin rows are covered (including soft-disabled ones: a disabled account
-- resolves to the empty set regardless of role, and re-enabling should restore
-- the assignment without a second backfill). Idempotent: the
-- (user_id, role_id) unique index + NOT EXISTS guard make re-runs no-ops. Runs
-- after 0033 seeds the super_admin role, so the SELECT always finds it.
INSERT INTO "user_roles" ("user_id","role_id")
  SELECT u."id", r."id"
  FROM "users" u
  CROSS JOIN "roles" r
  WHERE u."role" = 'admin'
    AND r."key" = 'super_admin'
    AND NOT EXISTS (
      SELECT 1 FROM "user_roles" ur
      WHERE ur."user_id" = u."id" AND ur."role_id" = r."id"
    );
