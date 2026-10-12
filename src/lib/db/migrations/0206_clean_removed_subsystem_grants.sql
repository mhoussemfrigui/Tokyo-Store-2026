-- 0206 — Clean orphaned RBAC grants for the six removed subsystems. Migration 0204
-- dropped the feature tables/columns, but the default roles still carried
-- role_permissions rows granting their now-invalid permission keys — collections:*,
-- loyalty:* / loyalty:view, businesses:* / businesses:view, credit:*. The RBAC
-- registry no longer defines those modules, so isValidPermissionKey() rejects them:
-- they are dead grants (the credit-note / avoir document is gated by orders:manage,
-- NOT a credit:* key, so dropping every credit:% grant is safe). Forward DELETE over
-- role_permissions + user_permissions; idempotent.
DELETE FROM "role_permissions"
 WHERE "permission" LIKE 'collections:%'
    OR "permission" LIKE 'loyalty:%'
    OR "permission" LIKE 'businesses:%'
    OR "permission" LIKE 'credit:%';--> statement-breakpoint
DELETE FROM "user_permissions"
 WHERE "permission" LIKE 'collections:%'
    OR "permission" LIKE 'loyalty:%'
    OR "permission" LIKE 'businesses:%'
    OR "permission" LIKE 'credit:%';
