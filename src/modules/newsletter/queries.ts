import "server-only";

import { and, count, desc, eq, sql, type SQL } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { newsletter_subscriptions, type NewsletterSubscriptionRow } from "./schema";

/**
 * Read-side helpers for the newsletter module.
 *
 * Admin pages should consume these (`newsletterQueries.list*`) instead of
 * reaching for `newsletterService` directly — keeps the admin/service seam
 * one-way (writes via workflows, reads via queries).
 */

export type SubscriberStatusFilter = "active" | "inactive" | "all";

export type SubscriberFilters = {
  status?: SubscriberStatusFilter;
  /** Case-insensitive substring of the email. */
  q?: string;
};

/** Escape LIKE metacharacters so the admin's search is matched literally. */
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (m) => `\\${m}`);
}

function filterConditions(filters: SubscriberFilters): SQL | undefined {
  const conds: SQL[] = [];
  if (filters.status === "active") conds.push(eq(newsletter_subscriptions.is_active, true));
  if (filters.status === "inactive") conds.push(eq(newsletter_subscriptions.is_active, false));
  // Same 100-char cap as the email-log search: a filter fragment never needs more.
  const needle = filters.q?.trim().toLowerCase().slice(0, 100);
  if (needle) {
    conds.push(sql`lower(${newsletter_subscriptions.email}) like ${`%${escapeLike(needle)}%`}`);
  }
  return conds.length ? and(...conds) : undefined;
}

/**
 * One PAGE of subscribers (newest first) for the admin list — filtered and
 * paginated in SQL, so search / tabs reach the WHOLE table instead of the
 * newest few hundred rows the panel used to filter client-side.
 */
export async function listSubscribers(
  opts: SubscriberFilters & { limit?: number; offset?: number } = {},
): Promise<NewsletterSubscriptionRow[]> {
  return db
    .select()
    .from(newsletter_subscriptions)
    .where(filterConditions(opts))
    .orderBy(desc(newsletter_subscriptions.created_at), desc(newsletter_subscriptions.id))
    .limit(Math.min(Math.max(1, opts.limit ?? 50), 200))
    .offset(Math.max(0, opts.offset ?? 0));
}

/** Row count for the same filters (drives the admin pagination). */
export async function countSubscribers(filters: SubscriberFilters = {}): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(newsletter_subscriptions)
    .where(filterConditions(filters));
  return Number(row?.value ?? 0);
}

/** Whole-table active / unsubscribed / total tallies (the admin stat cards). */
export async function subscriberStatusCounts(): Promise<{
  active: number;
  inactive: number;
  total: number;
}> {
  const rows = await db
    .select({ active: newsletter_subscriptions.is_active, value: count() })
    .from(newsletter_subscriptions)
    .groupBy(newsletter_subscriptions.is_active);
  let active = 0;
  let inactive = 0;
  for (const r of rows) {
    if (r.active) active += Number(r.value);
    else inactive += Number(r.value);
  }
  return { active, inactive, total: active + inactive };
}

export async function findSubscriberById(id: string): Promise<NewsletterSubscriptionRow | null> {
  const [row] = await db
    .select()
    .from(newsletter_subscriptions)
    .where(eq(newsletter_subscriptions.id, id))
    .limit(1);
  return row ?? null;
}

/**
 * Keyset-paged read for the streamed CSV export, newest first. Keyed on the id
 * ALONE: ids are time-ordered UUID v7, and an id cursor sidesteps the
 * µs-vs-ms truncation a JS-Date `created_at` cursor suffers (see
 * lib/api/keyset.ts) — no row skipped or repeated, and rows inserted
 * mid-export can't shift the pages the way an OFFSET would. Pass the last id of
 * the previous page as `afterId`.
 */
export async function listSubscribersForExport(
  filters: SubscriberFilters,
  opts: { limit: number; afterId?: string },
): Promise<NewsletterSubscriptionRow[]> {
  const base = filterConditions(filters);
  const keyset = opts.afterId
    ? sql`${newsletter_subscriptions.id} < ${opts.afterId}::uuid`
    : undefined;
  return db
    .select()
    .from(newsletter_subscriptions)
    .where(base && keyset ? and(base, keyset) : (base ?? keyset))
    .orderBy(desc(newsletter_subscriptions.id))
    .limit(opts.limit);
}

export async function countActiveSubscribers(): Promise<number> {
  // SQL COUNT instead of pulling every active row over the wire just to
  // get a single number for the dashboard.
  const [row] = await db
    .select({ value: count() })
    .from(newsletter_subscriptions)
    .where(eq(newsletter_subscriptions.is_active, true));
  return Number(row?.value ?? 0);
}
