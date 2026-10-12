import { boolean, index, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { id, timestamps } from "@/lib/db/columns";

/**
 * RBAC module — roles, their permission grants, and user↔role assignments.
 *
 * Design (deliberately NOT a `permissions` table):
 *   - The set of permissions that EXIST is a CODE registry
 *     (`src/lib/rbac/registry.ts`), keyed by admin-nav id + action
 *     (`products:create`, `orders:manage`, …). Adding a privilege is a
 *     one-line edit there — no migration, no seed. A DB `permissions` table
 *     would force a migration every time the app grows a capability, which is
 *     the opposite of the "as upgradable as possible" goal.
 *   - This module stores only the GRANTS: which role holds which permission
 *     key (`role_permissions.permission`, a free-text code key, including the
 *     wildcards `'*'` = everything and `'<module>:*'` = all actions on a
 *     module), and which user holds which role (`user_roles`).
 *   - Stale grants (a key later removed from the registry) are simply ignored
 *     at authorize time — self-healing, no integrity sweep needed.
 *
 * Links: intra-module FKs to `roles` are real (ON DELETE CASCADE), matching the
 * auth module's sessions→users FK. The cross-module link to `users`
 * (`user_roles.user_id`) is a SOFT text link with NO FK — same convention as
 * `orders.user_id` — so the people modules stay independently swappable.
 *
 * Access is ROLE-ONLY: the legacy `users.role` enum (customer|staff|admin) was
 * retired (migration 0193). Full access (`'*'`) comes solely from a role grant
 * (the seeded `super_admin` role); the coarse account TYPE is derived from the
 * effective permission set (lib/rbac/account-type.ts). See `authorize.ts`.
 */

export const roles = pgTable(
  "roles",
  {
    id: id(),
    /** Stable slug used in code/seeds (e.g. "super_admin"). Unique. */
    key: text("key").notNull(),
    /** Human label shown in the admin role editor. */
    name: text("name").notNull(),
    description: text("description"),
    /**
     * System roles (seeded, e.g. super_admin) can be granted/assigned but must
     * never be renamed away from their key or deleted — the role editor (Phase
     * 3) enforces this. Kept as a column so the guard is data-driven.
     */
    is_system: boolean("is_system").notNull().default(false),
    ...timestamps(),
  },
  (table) => ({
    keyUnique: uniqueIndex("roles_key_unique").on(table.key),
  }),
);

export const role_permissions = pgTable(
  "role_permissions",
  {
    id: id(),
    // FK (→ roles, ON DELETE CASCADE) lives in the migration SQL per convention.
    role_id: uuid("role_id").notNull(),
    /** Code-registry permission key, or a wildcard ("*" / "<module>:*"). */
    permission: text("permission").notNull(),
    ...timestamps(),
  },
  (table) => ({
    rolePermUnique: uniqueIndex("role_permissions_role_perm_unique").on(
      table.role_id,
      table.permission,
    ),
    roleIdx: index("role_permissions_role_idx").on(table.role_id),
  }),
);

export const user_roles = pgTable(
  "user_roles",
  {
    id: id(),
    /** Soft link to auth.users.id (text, no FK — cross-module). */
    user_id: text("user_id").notNull(),
    // FK (→ roles, ON DELETE CASCADE) lives in the migration SQL per convention.
    role_id: uuid("role_id").notNull(),
    ...timestamps(),
  },
  (table) => ({
    userRoleUnique: uniqueIndex("user_roles_user_role_unique").on(table.user_id, table.role_id),
    userIdx: index("user_roles_user_idx").on(table.user_id),
    roleIdx: index("user_roles_role_idx").on(table.role_id),
  }),
);

/**
 * Per-user permission OVERLAY (migration 0191) — allow/deny deltas layered over
 * the union of a user's role grants, so a role is a customizable template.
 * `permission` is a code-registry key or a `<module>:*` wildcard (never the global
 * `'*'` — that stays role-only). `effect` is `allow` | `deny` (deny wins at merge
 * time — see `src/lib/rbac/overlay.ts`). Soft text link to users.id (no FK).
 */
export const user_permissions = pgTable(
  "user_permissions",
  {
    id: id(),
    user_id: text("user_id").notNull(),
    /** Code-registry key or `<module>:*` wildcard (the global `*` is never stored here). */
    permission: text("permission").notNull(),
    /** `allow` adds the key for this user; `deny` removes it from the role baseline. */
    effect: text("effect").notNull().default("allow"),
    ...timestamps(),
  },
  (table) => ({
    userPermUnique: uniqueIndex("user_permissions_user_perm_unique").on(table.user_id, table.permission),
    userIdx: index("user_permissions_user_idx").on(table.user_id),
  }),
);

export type RoleRow = typeof roles.$inferSelect;
export type NewRoleRow = typeof roles.$inferInsert;
