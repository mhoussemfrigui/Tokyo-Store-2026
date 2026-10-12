-- 0191 — RBAC per-user permission OVERLAY. Add-only, idempotent.
--
-- A role is the baseline template; this table layers per-user allow/deny deltas on
-- top so one account can have specific actions added or removed without a dedicated
-- role. Effective = union(role grants) ∪ allow − deny (deny wins; see lib/rbac/overlay.ts).
-- `permission` is a code-registry key or a wildcard ("<module>:*"); the GLOBAL "*" is
-- never a valid override target (super-admin stays a role-only decision — enforced in
-- the workflow). Soft text link to users.id (no FK — cross-module, like user_roles).
CREATE TABLE IF NOT EXISTS "user_permissions" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
  "user_id" text NOT NULL,
  "permission" text NOT NULL,
  "effect" text NOT NULL DEFAULT 'allow',
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "user_permissions_effect_check" CHECK ("effect" IN ('allow', 'deny'))
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "user_permissions_user_perm_unique" ON "user_permissions" ("user_id", "permission");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_permissions_user_idx" ON "user_permissions" ("user_id");
