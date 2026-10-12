import "server-only";

import { and, count, eq, inArray, sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import {
  role_permissions,
  roles,
  user_permissions,
  user_roles,
  type NewRoleRow,
  type RoleRow,
} from "./schema";

/** A per-user overlay delta — one allow/deny over the role baseline. */
export type PermissionOverrideInput = { permission: string; effect: "allow" | "deny" };

/**
 * RBAC service — pure CRUD on the module's own tables (roles, grants,
 * assignments). No business logic, no other-module imports, no auth/session
 * concerns. The authorize ENGINE (legacy-enum bridge + wildcard matching) lives
 * in `src/lib/rbac/authorize.ts`; permission-key validation against the code
 * registry happens at the action layer (Phase 3 role editor).
 */
class RbacService {
  // ─────────────────────────────────────────────── authorize hot path
  /**
   * Union of permission keys granted to a user via ALL assigned roles. Raw
   * keys only (may include "*" / "<module>:*"); the wildcard + legacy-enum
   * interpretation is the engine's job. One indexed join, no soft-delete column
   * (revocation = deleting the user_roles row), so this stays cheap on the
   * per-request authorize path.
   */
  async listPermissionsForUser(userId: string): Promise<string[]> {
    const rows = await db
      .select({ permission: role_permissions.permission })
      .from(user_roles)
      .innerJoin(role_permissions, eq(role_permissions.role_id, user_roles.role_id))
      .where(eq(user_roles.user_id, userId));
    return rows.map((r) => r.permission);
  }

  // ─────────────────────────────────────────────── roles
  async listRoles(): Promise<RoleRow[]> {
    return db.select().from(roles).orderBy(roles.name);
  }

  async findRoleById(id: string): Promise<RoleRow | null> {
    const [row] = await db.select().from(roles).where(eq(roles.id, id)).limit(1);
    return row ?? null;
  }

  async findRoleByKey(key: string): Promise<RoleRow | null> {
    const [row] = await db.select().from(roles).where(eq(roles.key, key)).limit(1);
    return row ?? null;
  }

  async createRole(input: NewRoleRow): Promise<RoleRow> {
    const [row] = await db.insert(roles).values(input).returning();
    return row;
  }

  /** Patch a role's display fields (never its `key` or `is_system` — those are
   *  immutable identity; the action layer rejects attempts to change them). */
  async updateRole(
    id: string,
    patch: { name?: string; description?: string | null },
  ): Promise<RoleRow | null> {
    const [row] = await db
      .update(roles)
      .set({ ...patch, updated_at: sql`now()` })
      .where(eq(roles.id, id))
      .returning();
    return row ?? null;
  }

  /** Delete a role — its grants + assignments cascade (FK ON DELETE CASCADE).
   *  The action layer refuses to delete a system role. */
  async deleteRole(id: string): Promise<void> {
    await db.delete(roles).where(eq(roles.id, id));
  }

  /** Roles + their permission-grant count + assigned-user count, for the admin
   *  roles list. Two grouped aggregates merged in memory (role count is tiny). */
  async listRolesWithCounts(): Promise<
    Array<RoleRow & { permissionCount: number; userCount: number }>
  > {
    const roleRows = await this.listRoles();
    if (roleRows.length === 0) return [];
    const [permCounts, userCounts] = await Promise.all([
      db
        .select({ roleId: role_permissions.role_id, c: count() })
        .from(role_permissions)
        .groupBy(role_permissions.role_id),
      db
        .select({ roleId: user_roles.role_id, c: count() })
        .from(user_roles)
        .groupBy(user_roles.role_id),
    ]);
    const permMap = new Map(permCounts.map((r) => [r.roleId, Number(r.c)]));
    const userMap = new Map(userCounts.map((r) => [r.roleId, Number(r.c)]));
    return roleRows.map((r) => ({
      ...r,
      permissionCount: permMap.get(r.id) ?? 0,
      userCount: userMap.get(r.id) ?? 0,
    }));
  }

  // ─────────────────────────────────────────────── grants
  async listPermissionsForRole(roleId: string): Promise<string[]> {
    const rows = await db
      .select({ permission: role_permissions.permission })
      .from(role_permissions)
      .where(eq(role_permissions.role_id, roleId));
    return rows.map((r) => r.permission);
  }

  /**
   * Batched grants for many roles — one `WHERE role_id IN (...)` instead of the
   * per-role N+1 the roles list previously fanned out. Returns role id → perms.
   */
  async listPermissionsForRoles(roleIds: string[]): Promise<Map<string, string[]>> {
    const map = new Map<string, string[]>();
    if (roleIds.length === 0) return map;
    const rows = await db
      .select({ roleId: role_permissions.role_id, permission: role_permissions.permission })
      .from(role_permissions)
      .where(inArray(role_permissions.role_id, roleIds));
    for (const r of rows) {
      const arr = map.get(r.roleId);
      if (arr) arr.push(r.permission);
      else map.set(r.roleId, [r.permission]);
    }
    return map;
  }

  /**
   * Replace a role's entire grant set atomically (the Phase 3 role-editor
   * primitive). Dedupes; callers validate keys against the registry first.
   */
  async setRolePermissions(roleId: string, permissions: string[]): Promise<void> {
    const unique = Array.from(new Set(permissions));
    await db.transaction(async (tx) => {
      await tx.delete(role_permissions).where(eq(role_permissions.role_id, roleId));
      if (unique.length > 0) {
        await tx
          .insert(role_permissions)
          .values(unique.map((permission) => ({ role_id: roleId, permission })));
      }
    });
  }

  // ─────────────────────────────────────────────── assignments
  /** Idempotent: the (user_id, role_id) unique index makes a re-assign a no-op. */
  async assignRoleToUser(userId: string, roleId: string): Promise<void> {
    await db
      .insert(user_roles)
      .values({ user_id: userId, role_id: roleId })
      .onConflictDoNothing();
  }

  async removeRoleFromUser(userId: string, roleId: string): Promise<void> {
    await db
      .delete(user_roles)
      .where(and(eq(user_roles.user_id, userId), eq(user_roles.role_id, roleId)));
  }

  /**
   * Assign a role to a user by its stable key (e.g. "super_admin") — composes
   * findRoleByKey + assignRoleToUser. Returns false when no such role exists
   * (so callers can log rather than throw on a misconfigured/unmigrated key).
   * Idempotent. Used by the admin bootstrap paths to make a fresh admin a
   * first-class super_admin, not only an enum-bridge admin.
   */
  async grantRoleByKey(userId: string, key: string): Promise<boolean> {
    const role = await this.findRoleByKey(key);
    if (!role) return false;
    await this.assignRoleToUser(userId, role.id);
    return true;
  }

  async listRolesForUser(userId: string): Promise<RoleRow[]> {
    return db
      .select({
        id: roles.id,
        key: roles.key,
        name: roles.name,
        description: roles.description,
        is_system: roles.is_system,
        created_at: roles.created_at,
        updated_at: roles.updated_at,
      })
      .from(user_roles)
      .innerJoin(roles, eq(roles.id, user_roles.role_id))
      .where(eq(user_roles.user_id, userId));
  }

  // ─────────────────────────────────────────────── per-user overlay (0191)
  /**
   * A user's allow/deny overlay deltas (empty for ~99% of accounts → the fast
   * path in `applyPermissionOverlay`). Part of the authorize hot path, so one
   * indexed lookup by user_id.
   */
  async listUserPermissionOverrides(userId: string): Promise<PermissionOverrideInput[]> {
    const rows = await db
      .select({ permission: user_permissions.permission, effect: user_permissions.effect })
      .from(user_permissions)
      .where(eq(user_permissions.user_id, userId));
    return rows.map((r) => ({ permission: r.permission, effect: r.effect === "deny" ? "deny" : "allow" }));
  }

  /**
   * Replace a user's entire overlay atomically (the per-user permissions editor
   * primitive). Dedupes by permission (last effect wins); empty input clears the
   * overlay (back to plain role grants). Callers validate keys + escalation first.
   */
  async setUserPermissionOverrides(userId: string, overrides: PermissionOverrideInput[]): Promise<void> {
    const byKey = new Map<string, "allow" | "deny">();
    for (const o of overrides) byKey.set(o.permission, o.effect === "deny" ? "deny" : "allow");
    await db.transaction(async (tx) => {
      await tx.delete(user_permissions).where(eq(user_permissions.user_id, userId));
      if (byKey.size > 0) {
        await tx
          .insert(user_permissions)
          .values([...byKey].map(([permission, effect]) => ({ user_id: userId, permission, effect })));
      }
    });
  }
}

export const rbacService = new RbacService();
export type { RbacService };
