-- 0193 — Drop the legacy `users.role` enum column entirely. LAST step of the
-- RBAC enum retirement: ships only AFTER every code read of `users.role` is gone
-- (authorize/guards bridge removed, admin UI + notification recipients + account
-- derivation moved to RBAC roles) and AFTER 0192 backfilled `super_admin` onto
-- every enum admin, so no account loses access.
--
-- Access is now ROLE-ONLY: full access (`*`) comes solely from a role grant, and
-- the coarse account TYPE (Client/Staff/Admin) is DERIVED from the effective
-- permission set (lib/rbac/account-type.ts + lib/rbac/roster.ts). Nothing writes
-- or reads the column after this.
--
-- Idempotent: IF EXISTS on the index, column and enum type so a re-run is a no-op.
DROP INDEX IF EXISTS "users_role_idx";

ALTER TABLE "users" DROP COLUMN IF EXISTS "role";

DROP TYPE IF EXISTS "user_role";
