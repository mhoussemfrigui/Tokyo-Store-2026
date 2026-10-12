-- Phase 1 — RBAC foundation: roles, permission grants, user↔role assignments.
--
-- Permission KEYS live in code (src/lib/rbac/registry.ts), NOT in a table — so
-- growing a capability is a one-line edit, no migration. This stores only the
-- GRANTS (which role holds which key) and ASSIGNMENTS (which user holds which
-- role). The legacy users.role enum (customer|staff|admin) is unchanged; the
-- authorize engine bridges enum 'admin' to the '*' wildcard so existing admins
-- keep full access with zero seeded user_roles rows.
--
-- Intra-module FKs to roles are real (ON DELETE CASCADE); the cross-module link
-- to users (user_roles.user_id) is a soft text link with no FK, per convention.
-- Idempotent: IF NOT EXISTS on every object + WHERE NOT EXISTS on the seed.
CREATE TABLE IF NOT EXISTS "roles" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  "key" text NOT NULL,
  "name" text NOT NULL,
  "description" text,
  "is_system" boolean NOT NULL DEFAULT false,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "roles_key_unique" ON "roles" ("key");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "role_permissions" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  "role_id" uuid NOT NULL REFERENCES "roles"("id") ON DELETE CASCADE,
  "permission" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "role_permissions_role_perm_unique" ON "role_permissions" ("role_id","permission");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "role_permissions_role_idx" ON "role_permissions" ("role_id");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "user_roles" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  "user_id" text NOT NULL,
  "role_id" uuid NOT NULL REFERENCES "roles"("id") ON DELETE CASCADE,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "user_roles_user_role_unique" ON "user_roles" ("user_id","role_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_roles_user_idx" ON "user_roles" ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_roles_role_idx" ON "user_roles" ("role_id");--> statement-breakpoint
-- Seed the super_admin system role + its single wildcard grant. The wildcard
-- ('*') means every present AND future permission key is covered with no
-- further seeding. Idempotent via WHERE NOT EXISTS (re-runs are no-ops).
INSERT INTO "roles" ("key","name","description","is_system")
  SELECT 'super_admin',
         'Super administrateur',
         'Accès total — toutes les sections et toutes les actions. Rôle système, non supprimable.',
         true
  WHERE NOT EXISTS (SELECT 1 FROM "roles" WHERE "key" = 'super_admin');--> statement-breakpoint
INSERT INTO "role_permissions" ("role_id","permission")
  SELECT r."id", '*'
  FROM "roles" r
  WHERE r."key" = 'super_admin'
    AND NOT EXISTS (
      SELECT 1 FROM "role_permissions" rp
      WHERE rp."role_id" = r."id" AND rp."permission" = '*'
    );
