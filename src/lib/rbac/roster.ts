import "server-only";

import { and, eq, inArray, sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { users } from "@/modules/auth/schema";
import { role_permissions, user_permissions, user_roles } from "@/modules/rbac/schema";
import { WILDCARD } from "./registry";
import { type AccountType } from "./account-type";

/**
 * Cross-cutting `users × RBAC` joins — they live here (not in rbacService) because
 * they span modules, same rule as guards.ts. Used by the Utilisateurs list + KPIs so
 * a derived account-type never costs an N+1.
 */

/**
 * Is this an INTERNAL account (staff or admin), i.e. NOT a plain customer? The
 * canonical predicate behind every "customer vs. internal" decision (social-signup
 * profile creation, delete-customer login handling), kept in lockstep with
 * `accountTypesForUsers` / `resolveAccountType`: internal = holds ≥1 effective role
 * GRANT (a role that actually carries a permission) OR ≥1 per-user ALLOW override.
 * A role that grants NOTHING, or an unknown/absent user, resolves to customer
 * (false). A DENY override never downgrades (it's a restriction, not a demotion).
 */
/**
 * Does any account assigned `roleId` carry a per-user DENY override? Used by the
 * role-authoring path before NEWLY adding the global `*` to a role: a `*` role on
 * a deny-override holder would materialize the `*` away (a "phantom" super-admin),
 * so the write is refused until the holder's restrictions are cleared. Cheap
 * EXISTS over user_roles × user_permissions.
 */
export async function anyRoleHolderHasDenyOverride(roleId: string): Promise<boolean> {
  const rows = await db
    .select({ one: sql<number>`1` })
    .from(user_roles)
    .innerJoin(
      user_permissions,
      and(eq(user_permissions.user_id, user_roles.user_id), eq(user_permissions.effect, "deny")),
    )
    .where(eq(user_roles.role_id, roleId))
    .limit(1);
  return rows.length > 0;
}

export async function isInternalAccount(userId: string): Promise<boolean> {
  const [row] = await db
    .select({
      internal: sql<boolean>`(count(${role_permissions.permission}) > 0 OR bool_or(${user_permissions.permission} IS NOT NULL))`,
    })
    .from(users)
    .leftJoin(user_roles, eq(user_roles.user_id, users.id))
    .leftJoin(role_permissions, eq(role_permissions.role_id, user_roles.role_id))
    .leftJoin(
      user_permissions,
      and(eq(user_permissions.user_id, users.id), eq(user_permissions.effect, "allow")),
    )
    .where(eq(users.id, userId))
    .groupBy(users.id);
  return Boolean(row?.internal);
}

/**
 * Coarse ACCOUNT-TYPE (customer|staff|admin) for MANY users in ONE grouped query —
 * the batched form of `resolveAccountType` for the Utilisateurs list (a per-row
 * resolve would be an N+1). SAME rule as `resolveAccountType`: `admin` = holds `*`
 * (role-only), `staff` = holds ≥1 role grant OR a per-user ALLOW override, `customer`
 * = none. A DENY override does NOT downgrade the label. Users absent from the map are
 * `customer`.
 */
export async function accountTypesForUsers(userIds: string[]): Promise<Map<string, AccountType>> {
  const map = new Map<string, AccountType>();
  if (userIds.length === 0) return map;
  const rows = await db
    .select({
      id: users.id,
      wildcard: sql<boolean>`bool_or(${role_permissions.permission} = ${WILDCARD})`,
      hasGrant: sql<boolean>`(count(${role_permissions.permission}) > 0 OR bool_or(${user_permissions.permission} IS NOT NULL))`,
    })
    .from(users)
    .leftJoin(user_roles, eq(user_roles.user_id, users.id))
    .leftJoin(role_permissions, eq(role_permissions.role_id, user_roles.role_id))
    .leftJoin(
      user_permissions,
      and(eq(user_permissions.user_id, users.id), eq(user_permissions.effect, "allow")),
    )
    .where(inArray(users.id, userIds))
    .groupBy(users.id);
  for (const r of rows) {
    map.set(r.id, r.wildcard ? "admin" : r.hasGrant ? "staff" : "customer");
  }
  return map;
}

/**
 * Store-wide account-type tally for the KPI strip, DERIVED — not a stored enum.
 * "Internal" here matches {@link accountTypesForUsers} / {@link isInternalAccount}
 * EXACTLY so the strip and the per-row badges can never disagree: an account is
 * internal when it holds ≥1 effective role GRANT (a role carrying a permission) OR
 * ≥1 per-user ALLOW override. A role that grants NOTHING does NOT make a customer
 * "staff" (the HAVING below drops it). Among the internal set, `*`-holders are
 * admins and the rest are staff; everyone else is a customer. `total` is the
 * all-accounts count.
 *
 * PERF: this runs on every /admin/users load, so it NEVER scans the `users` table
 * (the full customer base). It starts from the small UNION of role-holders +
 * allow-override holders — bounded by the RBAC tables, which are tiny vs. users.
 */
export async function accountTypeCounts(total: number): Promise<{
  admins: number;
  staff: number;
  customers: number;
}> {
  const result = await db.execute<{ wildcard: boolean }>(sql`
    SELECT bool_or(rp."permission" = ${WILDCARD}) AS wildcard
    FROM (
      SELECT "user_id" FROM ${user_roles}
      UNION
      SELECT "user_id" FROM ${user_permissions} WHERE "effect" = 'allow'
    ) ids
    -- JOIN users by PK (index lookup for the small internal set, NOT a full scan):
    -- excludes orphaned grant rows (user_roles / user_permissions are soft text
    -- links with no FK, so a hard-deleted account can leave rows behind).
    JOIN ${users} u ON u."id" = ids."user_id"
    LEFT JOIN ${user_roles} ur ON ur."user_id" = ids."user_id"
    LEFT JOIN ${role_permissions} rp ON rp."role_id" = ur."role_id"
    LEFT JOIN ${user_permissions} up ON up."user_id" = ids."user_id" AND up."effect" = 'allow'
    GROUP BY ids."user_id"
    HAVING count(rp."permission") > 0 OR bool_or(up."permission" IS NOT NULL)
  `);
  const rows = result.rows as { wildcard: boolean | null }[];
  let admins = 0;
  for (const r of rows) if (r.wildcard) admins++;
  const internal = rows.length;
  return { admins, staff: internal - admins, customers: Math.max(0, total - internal) };
}
