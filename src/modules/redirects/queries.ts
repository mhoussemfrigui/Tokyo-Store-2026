import "server-only";

import { and, desc, eq, ilike, or, sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { redirects, type RedirectRow } from "./schema";

/**
 * Reads for the redirects module. The resolver uses {@link findActiveBySource}
 * (O(1) on the unique `source_path` index); the admin list uses the paginated
 * {@link listPage}.
 */

/** Active redirect for an exact (already-normalized) source path, or null. */
export async function findActiveBySource(sourcePath: string): Promise<RedirectRow | null> {
  const [row] = await db
    .select()
    .from(redirects)
    .where(and(eq(redirects.source_path, sourcePath), eq(redirects.is_active, true)))
    .limit(1);
  return row ?? null;
}

/** One page of redirects (newest first) + the total count, with optional search. */
export async function listPage(opts: {
  limit: number;
  offset: number;
  search?: string;
}): Promise<{ rows: RedirectRow[]; total: number }> {
  const term = opts.search?.trim();
  const where = term
    ? or(ilike(redirects.source_path, `%${term}%`), ilike(redirects.destination, `%${term}%`))
    : undefined;
  const [rows, [{ count }]] = await Promise.all([
    db
      .select()
      .from(redirects)
      .where(where)
      .orderBy(desc(redirects.created_at))
      .limit(opts.limit)
      .offset(opts.offset),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(redirects)
      .where(where),
  ]);
  return { rows, total: count ?? 0 };
}

/** Lightweight totals for the admin header (total + active). */
export async function counts(): Promise<{ total: number; active: number }> {
  const [row] = await db
    .select({
      total: sql<number>`count(*)::int`,
      active: sql<number>`count(*) filter (where ${redirects.is_active})::int`,
    })
    .from(redirects);
  return { total: row?.total ?? 0, active: row?.active ?? 0 };
}
