import "server-only";

import { unstable_cache } from "next/cache";
import { and, desc, eq, gte, ilike, isNotNull, like, lt, lte, sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { audit_log, type AuditLogRow } from "./schema";
import { clampAuditLimit, parseAuditCursor } from "./cursor";

export type AuditListFilters = {
  /** Exact event name (e.g. "product.updated"). */
  eventName?: string;
  /** Domain prefix (e.g. "order" → all "order.*" events). */
  domain?: string;
  /** debug|info|warn|error. */
  severity?: string;
  actorUserId?: string;
  targetType?: string;
  targetId?: string;
  /** Free-text contains over the summary (ILIKE, unindexed — admin only). */
  summary?: string;
  /** created_at lower bound (inclusive). */
  from?: Date;
  /** created_at upper bound (inclusive). */
  to?: Date;
};

/** Turn a filter object into the drizzle condition list (no cursor). */
function buildConditions(f: AuditListFilters) {
  const conditions = [];
  if (f.eventName) conditions.push(eq(audit_log.event_name, f.eventName));
  if (f.domain) conditions.push(like(audit_log.event_name, `${f.domain}.%`));
  if (f.severity) conditions.push(eq(audit_log.severity, f.severity));
  if (f.actorUserId) conditions.push(eq(audit_log.actor_user_id, f.actorUserId));
  if (f.targetType) conditions.push(eq(audit_log.target_type, f.targetType));
  if (f.targetId) conditions.push(eq(audit_log.target_id, f.targetId));
  if (f.summary) conditions.push(ilike(audit_log.summary, `%${f.summary}%`));
  if (f.from) conditions.push(gte(audit_log.created_at, f.from));
  if (f.to) conditions.push(lte(audit_log.created_at, f.to));
  return conditions;
}

/**
 * Keyset-paginated audit list. Orders by `id DESC` (uuid v7 = newest-first,
 * EXACT keyset — see cursor.ts for why id, not created_at). The cursor is the
 * last row's id; nextCursor is null when the page wasn't full.
 */
export async function listAuditEntries(
  opts: AuditListFilters & { limit?: number; cursor?: string },
): Promise<{ items: AuditLogRow[]; nextCursor: string | null }> {
  const limit = clampAuditLimit(opts.limit);
  const conditions = buildConditions(opts);
  const cursorId = parseAuditCursor(opts.cursor);
  if (cursorId) conditions.push(lt(audit_log.id, cursorId));

  const items = await db
    .select()
    .from(audit_log)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(audit_log.id))
    .limit(limit + 1);

  const hasMore = items.length > limit;
  const trimmed = hasMore ? items.slice(0, limit) : items;
  return {
    items: trimmed,
    nextCursor: hasMore ? trimmed[trimmed.length - 1].id : null,
  };
}

/** Projected row for the CSV export — everything EXCEPT the (large) metadata jsonb. */
export type AuditExportRow = {
  id: string;
  created_at: Date;
  severity: string;
  actor_user_id: string | null;
  event_name: string;
  target_type: string | null;
  target_id: string | null;
  actor_ip: string | null;
  summary: string | null;
};

/**
 * Keyset page for the CSV export — same filters/keyset as listAuditEntries but
 * COLUMN-PROJECTED so the dominant per-row cost (the up-to-16KB metadata jsonb,
 * which the CSV never includes) is never fetched. The export pages this up to
 * MAX_EXPORT_ROWS, so skipping metadata avoids buffering tens of MB of unused
 * jsonb in memory.
 */
export async function listAuditEntriesForExport(
  opts: AuditListFilters & { limit?: number; cursor?: string },
): Promise<{ items: AuditExportRow[]; nextCursor: string | null }> {
  const limit = clampAuditLimit(opts.limit);
  const conditions = buildConditions(opts);
  const cursorId = parseAuditCursor(opts.cursor);
  if (cursorId) conditions.push(lt(audit_log.id, cursorId));

  const items = await db
    .select({
      id: audit_log.id,
      created_at: audit_log.created_at,
      severity: audit_log.severity,
      actor_user_id: audit_log.actor_user_id,
      event_name: audit_log.event_name,
      target_type: audit_log.target_type,
      target_id: audit_log.target_id,
      actor_ip: audit_log.actor_ip,
      summary: audit_log.summary,
    })
    .from(audit_log)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(audit_log.id))
    .limit(limit + 1);

  const hasMore = items.length > limit;
  const trimmed = hasMore ? items.slice(0, limit) : items;
  return {
    items: trimmed,
    nextCursor: hasMore ? trimmed[trimmed.length - 1].id : null,
  };
}

// ── Analytics (Statistiques tab) ────────────────────────────────────────────

export type AuditOverview = {
  total: number;
  last24h: number;
  /** count keyed by severity (debug|info|warn|error). Missing keys = 0. */
  bySeverity: Record<string, number>;
  /** distinct event_name values present — the "coverage" signal. */
  distinctEvents: number;
};

/**
 * Headline KPIs for the audit control center. `total` uses the planner's
 * `reltuples` estimate (O(1)) instead of a full count(*) — audit_log can reach
 * tens of millions of rows before the retention purge, where a real count +
 * the unbounded distinct/GROUP-BY would risk the 10s statement_timeout and (on
 * the page's `.catch`) silently render zeros. The whole result is cached for
 * 5 min (unstable_cache) so those scans run at most once per window regardless
 * of admin-page load rate; KPI counts don't need to be live. last-24h is bounded
 * + served by audit_created_id_idx; the severity GROUP BY + distinct-events are
 * full-table HashAggregates (fine at this cadence, NOT index-served).
 */
async function computeAuditOverview(): Promise<AuditOverview> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  // Planner estimate; fall back to an exact count only when unavailable (fresh
  // table never ANALYZEd → reltuples 0/-1).
  const est = await db.execute<{ c: number }>(
    sql`SELECT reltuples::bigint AS c FROM pg_class WHERE oid = 'public.audit_log'::regclass`,
  );
  let total = Number(est.rows[0]?.c ?? 0);
  if (total <= 0) {
    const [t] = await db.select({ c: sql<number>`count(*)::int` }).from(audit_log);
    total = t?.c ?? 0;
  }
  const [d1] = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(audit_log)
    .where(gte(audit_log.created_at, since));
  const [dis] = await db
    .select({ c: sql<number>`count(distinct ${audit_log.event_name})::int` })
    .from(audit_log);
  const sev = await db
    .select({ severity: audit_log.severity, c: sql<number>`count(*)::int` })
    .from(audit_log)
    .groupBy(audit_log.severity);
  const bySeverity: Record<string, number> = {};
  for (const r of sev) bySeverity[r.severity] = r.c;
  return { total, last24h: d1?.c ?? 0, bySeverity, distinctEvents: dis?.c ?? 0 };
}

const getAuditOverviewCached = unstable_cache(computeAuditOverview, ["audit-overview-v1"], {
  revalidate: 300,
});

export async function getAuditOverview(): Promise<AuditOverview> {
  return getAuditOverviewCached();
}

/**
 * The two Statistiques leaderboards below are all-time GROUP BYs over audit_log
 * — the same full-table HashAggregates the overview caches, and the page runs
 * them on EVERY Journal load (the tabs are client-side). Uncached, a large
 * audit_log would pay two full scans per visit and, past the 10s
 * statement_timeout, silently render empty tables (the page's `.catch`). So they
 * share the overview's 5-min unstable_cache window; the limit arg is part of the
 * cache key. Leaderboards don't need to be live.
 */
async function computeTopEvents(
  limit: number,
): Promise<{ eventName: string; severity: string; count: number }[]> {
  const rows = await db
    .select({
      eventName: audit_log.event_name,
      // The same event can carry one severity historically; min() is a stable pick.
      severity: sql<string>`min(${audit_log.severity})`,
      count: sql<number>`count(*)::int`,
    })
    .from(audit_log)
    .groupBy(audit_log.event_name)
    .orderBy(desc(sql`count(*)`))
    .limit(limit);
  return rows.map((r) => ({ eventName: r.eventName, severity: r.severity, count: r.count }));
}

const getTopEventsCached = unstable_cache(computeTopEvents, ["audit-top-events-v1"], {
  revalidate: 300,
});

/** Most-frequent events (all-time, cached 5 min), for the Statistiques tab. */
export async function getTopEvents(
  limit = 10,
): Promise<{ eventName: string; severity: string; count: number }[]> {
  return getTopEventsCached(limit);
}

async function computeTopActors(limit: number): Promise<{ actorUserId: string; count: number }[]> {
  const rows = await db
    .select({ actorUserId: audit_log.actor_user_id, count: sql<number>`count(*)::int` })
    .from(audit_log)
    .where(isNotNull(audit_log.actor_user_id))
    .groupBy(audit_log.actor_user_id)
    .orderBy(desc(sql`count(*)`))
    .limit(limit);
  // actor_user_id is non-null here (WHERE isNotNull) — assert for the type.
  return rows
    .filter((r): r is { actorUserId: string; count: number } => r.actorUserId != null)
    .map((r) => ({ actorUserId: r.actorUserId, count: r.count }));
}

const getTopActorsCached = unstable_cache(computeTopActors, ["audit-top-actors-v1"], {
  revalidate: 300,
});

/** Most-active actors (excludes système/null; cached 5 min), for the Statistiques tab. */
export async function getTopActors(
  limit = 10,
): Promise<{ actorUserId: string; count: number }[]> {
  return getTopActorsCached(limit);
}
