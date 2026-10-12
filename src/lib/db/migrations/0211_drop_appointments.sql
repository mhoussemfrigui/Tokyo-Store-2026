-- 0211 — Remove the Rendez-vous (appointments) feature entirely.
--
-- The appointments booking subsystem (admin section, storefront /rendez-vous
-- page, module, workflows, emails + events) has been removed from the codebase.
-- This drops its three tables (created in 0189, extended in 0190) and strips the
-- now-dead `appointments:*` permission grants from every role's permission array
-- so the role editor + RBAC no longer reference a module that doesn't exist.
-- Idempotent: IF EXISTS guards + a no-op array filter.

DROP TABLE IF EXISTS "appointments" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "appointment_reasons" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "appointment_locations" CASCADE;--> statement-breakpoint

-- Strip every `appointments:*` grant from the role_permissions join table (the
-- wildcard '*' of super_admin is untouched — only the explicit appointments
-- grants seeded for delegate roles in 0195 are removed).
DELETE FROM "role_permissions" WHERE "permission" LIKE 'appointments:%';
