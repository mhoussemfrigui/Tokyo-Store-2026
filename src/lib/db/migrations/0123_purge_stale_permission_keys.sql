-- Purge RBAC grants whose permission key no longer exists in the code registry
-- (src/lib/rbac/registry.ts). Registry removals that shipped without a cleanup
-- (unlike 0092 promo_links / 0097 announcements) left these rows behind; a stale
-- key confers nothing at authorization time, but the strict role-editor schema
-- rejected every later save of a role holding one ("Validation échouée") and the
-- escalation guards counted it against non-wildcard delegates.
--   - 3312569: the whole `preorders` module (preorders:view / preorders:update)
--   - 1a5b98d: cart:manage, invites:manage, system_database:manage,
--              users:update, users:delete, customers:create, system_mail:delete,
--              system_tax:create, system_tax:delete, showcase:create,
--              showcase:delete
--   - 496a3af: warranty:update
-- Every key below was re-verified absent from the registry (isValidPermissionKey
-- → false). Idempotent (a plain DELETE).
DELETE FROM "role_permissions"
WHERE "permission" IN (
  'cart:manage',
  'invites:manage',
  'system_database:manage',
  'users:update',
  'users:delete',
  'customers:create',
  'system_mail:delete',
  'system_tax:create',
  'system_tax:delete',
  'showcase:create',
  'showcase:delete',
  'warranty:update'
)
OR "permission" LIKE 'preorders:%';
