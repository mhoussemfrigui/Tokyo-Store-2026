import "server-only";

import { cache } from "react";
import { and, eq, isNull } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { users } from "@/modules/auth/schema";
import { role_permissions, user_roles } from "@/modules/rbac/schema";
import { WILDCARD } from "./registry";

/**
 * Emails of the EFFECTIVE admin set — the fallback recipient list for operator
 * alerts (low-stock, stock transfers, perf breaches) when no explicit list is
 * configured. One shared helper so the three subscribers that each inlined an
 * identical "active admins" lookup can never drift (and so none of them read the
 * retired `users.role` enum).
 *
 * "Admin" here matches the definition in guards.ts (the last-admin floor) and
 * roster.ts: any ACTIVE account holding the RBAC `*` permission via
 * user_roles → role_permissions. The wildcard grant is the sole source of
 * effective-admin now that the legacy `users.role` enum is dropped.
 *
 * React-cache()'d so a multi-event burst (several stock crossings in one order)
 * issues the lookup once per request. Best-effort: a DB failure returns [] —
 * alerts degrade to "not sent", never throw into the caller. Capped at 20.
 */
export const effectiveAdminEmails = cache(async (): Promise<string[]> => {
  try {
    const rows = await db
      .selectDistinct({ email: users.email })
      .from(users)
      .innerJoin(user_roles, eq(user_roles.user_id, users.id))
      .innerJoin(
        role_permissions,
        and(
          eq(role_permissions.role_id, user_roles.role_id),
          eq(role_permissions.permission, WILDCARD),
        ),
      )
      .where(isNull(users.disabledAt));
    return Array.from(
      new Set(rows.map((r) => r.email).filter((e): e is string => Boolean(e))),
    ).slice(0, 20);
  } catch {
    return [];
  }
});
