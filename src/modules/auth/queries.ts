import "server-only";

import { count, eq, gte, inArray, isNull } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { users, type UserRow } from "./schema";

/**
 * Read-side helpers for the auth module.
 *
 * These are aggregates / shaped reads that don't fit "find one row" — used by
 * Server Components and admin dashboards. Pure SELECT queries; never mutate.
 */

export async function getUserStats(): Promise<{
  total: number;
  newLast30Days: number;
}> {
  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  // Account TYPE (customer/staff/admin) is now DERIVED from RBAC grants, not a
  // stored enum — the per-type tally lives in `accountTypeCounts` (lib/rbac/roster),
  // used by the Utilisateurs KPI strip. This dashboard card only needs the totals.
  const [totalRow, newRow] = await Promise.all([
    db.select({ value: count() }).from(users).where(isNull(users.disabledAt)),
    db.select({ value: count() }).from(users).where(gte(users.createdAt, thirtyDaysAgo)),
  ]);

  return {
    total: Number(totalRow[0]?.value ?? 0),
    newLast30Days: Number(newRow[0]?.value ?? 0),
  };
}

/**
 * Batch lookup for admin screens that need to translate user IDs into
 * names/emails (order history, audit log). Missing ids are simply absent
 * from the returned map.
 */
export async function findUsersByIds(ids: string[]): Promise<Map<string, UserRow>> {
  if (ids.length === 0) return new Map();
  const rows = await db.select().from(users).where(inArray(users.id, ids));
  return new Map(rows.map((r) => [r.id, r]));
}

/**
 * Single-row read for admin-side actions that need to confirm a user
 * exists before triggering a workflow (toggleEmailVerified, password
 * reset). Public read-side helper so server actions don't bypass the
 * module barrel and reach into `service.ts`.
 */
export async function findUserById(id: string): Promise<UserRow | null> {
  const [row] = await db.select().from(users).where(eq(users.id, id)).limit(1);
  return row ?? null;
}
