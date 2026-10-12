-- 0192 — Backfill the super_admin ROLE onto every legacy enum admin, BEFORE the
-- `users.role → '*'` bridge is retired (code change in the same release). Idempotent.
--
-- Until now an account could be a full admin two ways: the enum `users.role='admin'`
-- (bridged to the `*` wildcard in authorize.ts) OR the `super_admin` RBAC role. The
-- bridge is being removed so `*` comes ONLY from a role. Any enum admin that does NOT
-- already hold a `*`-granting role would lose access the moment the bridge is gone, so
-- grant them `super_admin` first. Accounts created via the bootstrap already hold the
-- role; this covers any created with the (now-removed) enum select. No-op otherwise.
INSERT INTO "user_roles" ("user_id", "role_id")
SELECT u."id", r."id"
FROM "users" u
CROSS JOIN "roles" r
WHERE r."key" = 'super_admin'
  AND u."role" = 'admin'
  AND NOT EXISTS (
    SELECT 1
    FROM "user_roles" ur
    JOIN "role_permissions" rp ON rp."role_id" = ur."role_id"
    WHERE ur."user_id" = u."id" AND rp."permission" = '*'
  )
ON CONFLICT ("user_id", "role_id") DO NOTHING;
