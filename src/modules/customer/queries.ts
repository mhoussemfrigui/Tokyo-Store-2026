import "server-only";

import { count, isNull, sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { customer_profiles } from "./schema";

export async function getCustomerStats(): Promise<{
  total: number;
  newLast30Days: number;
}> {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  // ONE round-trip, one index/seq pass: total live profiles + a FILTERed count
  // of those created in the last 30 days (was two serial COUNT(*) queries).
  // Both honour the soft-delete convention — a created-then-deleted profile
  // must not inflate "new this month".
  const [row] = await db
    .select({
      total: count(),
      newLast30Days: sql<number>`count(*) FILTER (WHERE ${customer_profiles.created_at} >= ${thirtyDaysAgo})`,
    })
    .from(customer_profiles)
    .where(isNull(customer_profiles.deleted_at));

  return {
    total: Number(row?.total ?? 0),
    newLast30Days: Number(row?.newLast30Days ?? 0),
  };
}

/**
 * Daily new-customer counts over the last `days` days — powers the dashboard
 * "Nouveaux clients" KPI sparkline + its 30-day rollup/delta. Mirrors
 * `getDailyOrdersSeries`: a `generate_series` spine LEFT JOINed so days with no
 * signups come back as 0 (not missing), and the soft-delete convention is
 * honoured so a created-then-deleted profile doesn't inflate a day.
 */
export async function getDailyNewCustomersSeries(
  days = 30,
): Promise<Array<{ day: string; count: number }>> {
  // `days - 1`: generate_series is inclusive of both endpoints (N rows for N-1
  // days ago → today), matching getDailyOrdersSeries.
  const since = new Date(Date.now() - (days - 1) * 24 * 60 * 60 * 1000);
  const rows = await db.execute<{ day: string; count: string }>(sql`
    WITH day_series AS (
      SELECT generate_series(
        (${since.toISOString()}::timestamptz AT TIME ZONE 'Africa/Tunis')::date,
        (now() AT TIME ZONE 'Africa/Tunis')::date,
        '1 day'::interval
      )::date AS day
    )
    SELECT
      to_char(d.day, 'YYYY-MM-DD') AS day,
      COALESCE(COUNT(c.id)::int, 0)::text AS count
    FROM day_series d
    LEFT JOIN ${customer_profiles} c
      ON c.created_at >= (d.day::timestamp AT TIME ZONE 'Africa/Tunis')
      AND c.created_at < ((d.day + INTERVAL '1 day')::timestamp AT TIME ZONE 'Africa/Tunis')
      AND c.deleted_at IS NULL
    GROUP BY d.day
    ORDER BY d.day ASC
  `);
  return rows.rows.map((r) => ({ day: r.day, count: Number(r.count) }));
}
