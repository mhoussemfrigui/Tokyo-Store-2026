import "server-only";

import { and, sql, type SQL } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { orders } from "@/modules/order/schema";
import { STORE_TIME_ZONE } from "@/lib/time/store-tz";
import { parseIncrementalCursor } from "@/lib/api/cursor";
import type { GuestFilter, GuestRow, GuestStats } from "./guest-filter-shared";

/**
 * SERVER-side application of the guest-clients filter (./guest-filter-shared.ts). Powers
 * the search action (keyset-paginated list), the filterable stats header, and the
 * filtered CSV export — all off ONE query shape, so list / count / export always agree.
 *
 * SHAPE: guests are an AGGREGATE, not a table. `g` groups every guest order
 * (user_id IS NULL) by its identity — (lower(contact_email), contact_phone) — backed by
 * the migration-0066 partial index. Each group is then LEFT-JOIN-LATERAL'd to `users` on
 * lower(email) (index users_email_lower_idx; LATERAL LIMIT 1 so a rare lower(email)
 * collision can't duplicate a guest row) to surface the retro-link candidate account +
 * its customer profile. Keyset order is (last_at DESC, email_key DESC, phone DESC);
 * pre-group WHERE prunes email/phone-presence, the outer WHERE applies search / ranges /
 * dates / account.
 */

const INT4_MAX = 2_147_483_647;

const dtToCents = (dt: string): number | null => {
  const n = Number(dt);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 1000);
};
const intOrNull = (v: string): number | null => {
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 ? Math.min(INT4_MAX, n) : null;
};
const YMD = /^\d{4}-\d{2}-\d{2}$/;

/** The grouped-guest CTE `g` (pre-group WHERE prunes email/phone presence). Phone is
 *  COALESCEd to '' in the group key so a blank-string phone (ERP push) and a NULL phone
 *  for the same email collapse to ONE identity — otherwise they'd be two groups that both
 *  normalize to null downstream (duplicate list rows + colliding React keys). */
function guestCte(orderWhere: SQL[]): SQL {
  return sql`
    g as (
      select
        lower(o.contact_email) as email_key,
        coalesce(o.contact_phone, '') as phone,
        (array_agg(o.contact_email order by o.created_at desc))[1] as email,
        (array_agg(o.ship_full_name order by o.created_at desc))[1] as name,
        count(*)::int as order_count,
        coalesce(sum(o.total_cents) filter (where o.paid_at is not null), 0)::bigint as paid_spend,
        coalesce(sum(o.total_cents), 0)::bigint as total_spend,
        max(o.created_at) as last_at,
        min(o.created_at) as first_at,
        to_char(max(o.created_at) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as last_cursor
      from ${orders} o
      where ${and(...orderWhere)}
      group by lower(o.contact_email), coalesce(o.contact_phone, '')
    )`;
}

/** The retro-link account for a group: ≤1 row (LIMIT 1 folds any lower(email) collision,
 *  preferring a verified account) with its customer-profile id for the deep link. */
const acctJoin = sql`
  left join lateral (
    select u.id, u.email_verified, cul.customer_profile_id
    from users u
    left join customer_user_links cul on cul.user_id = u.id
    where g.email_key <> '' and lower(u.email) = g.email_key
    order by u.email_verified desc nulls last, u.created_at asc
    limit 1
  ) acct on true`;

/** Pre-group WHERE on `orders o` (always includes the guest predicate). */
function guestOrderWhere(f: GuestFilter): SQL[] {
  const c: SQL[] = [sql`o.user_id is null`];
  if (f.hasEmail === "yes") c.push(sql`coalesce(o.contact_email, '') <> ''`);
  else if (f.hasEmail === "no") c.push(sql`coalesce(o.contact_email, '') = ''`);
  if (f.hasPhone === "yes") c.push(sql`coalesce(o.contact_phone, '') <> ''`);
  else if (f.hasPhone === "no") c.push(sql`coalesce(o.contact_phone, '') = ''`);
  return c;
}

/** Outer WHERE on the grouped + account-joined set (seeded with `true` so it's never empty). */
function guestOuterWhere(f: GuestFilter): SQL[] {
  const c: SQL[] = [sql`true`];
  const q = f.search.trim();
  if (q) {
    const like = `%${q.toLowerCase()}%`;
    const phoneLike = `%${q}%`;
    c.push(
      sql`(lower(coalesce(g.email, '')) like ${like} or coalesce(g.phone, '') like ${phoneLike} or lower(coalesce(g.name, '')) like ${like})`,
    );
  }
  const ordersMin = intOrNull(f.ordersMin);
  if (f.ordersMin !== "" && ordersMin != null) c.push(sql`g.order_count >= ${ordersMin}`);
  const ordersMax = intOrNull(f.ordersMax);
  if (f.ordersMax !== "" && ordersMax != null) c.push(sql`g.order_count <= ${ordersMax}`);
  const spendMin = dtToCents(f.spendMin);
  if (f.spendMin !== "" && spendMin != null) c.push(sql`g.paid_spend >= ${spendMin}`);
  const spendMax = dtToCents(f.spendMax);
  if (f.spendMax !== "" && spendMax != null) c.push(sql`g.paid_spend <= ${spendMax}`);
  // Last-order date range anchored to the store zone (Africa/Tunis), like the clients filter.
  if (YMD.test(f.lastFrom)) c.push(sql`g.last_at >= (${f.lastFrom}::date at time zone ${STORE_TIME_ZONE})`);
  if (YMD.test(f.lastTo)) c.push(sql`g.last_at < ((${f.lastTo}::date + interval '1 day') at time zone ${STORE_TIME_ZONE})`);
  if (f.hasAccount === "yes") c.push(sql`acct.id is not null`);
  else if (f.hasAccount === "no") c.push(sql`acct.id is null`);
  return c;
}

type GuestListRow = {
  email_key: string | null;
  email: string | null;
  phone: string | null;
  name: string | null;
  order_count: number;
  paid_spend: string;
  total_spend: string;
  last_at: string | Date | null;
  first_at: string | Date | null;
  last_cursor: string | null;
  account_user_id: string | null;
  account_verified: boolean | null;
  account_profile_id: string | null;
};

const toIso = (v: string | Date | null): string | null =>
  v == null ? null : (v instanceof Date ? v : new Date(v)).toISOString();

/** One keyset page of enriched guest rows (used by the list action AND the export). */
export async function listFilteredGuests(
  filter: GuestFilter,
  opts: { cursor?: string; limit?: number } = {},
): Promise<{ items: GuestRow[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(opts.limit ?? 30, 1), 200);
  const outer = guestOuterWhere(filter);

  if (opts.cursor) {
    // Cursor = `<µs-iso>|<enc email_key>|<enc phone>`. The µs-iso has no '|'; the
    // email_key + phone are percent-ENCODED so a literal '|' in a (free-text, ERP-sourced)
    // phone can't corrupt the split — otherwise a stray pipe would shift the keyset
    // boundary and skip/duplicate guests across pages + in the CSV export.
    const parts = opts.cursor.split("|");
    if (parts.length === 3) {
      const ts = parseIncrementalCursor(new URLSearchParams({ since: parts[0] }));
      let curEmail: string | null = null;
      let curPhone: string | null = null;
      try {
        curEmail = decodeURIComponent(parts[1]);
        curPhone = decodeURIComponent(parts[2]);
      } catch {
        curEmail = null; // malformed cursor → ignore it (fall back to the first page)
      }
      if (ts.ok && ts.sinceIso && curEmail != null && curPhone != null) {
        outer.push(
          sql`(g.last_at < ${ts.sinceIso}::timestamptz or (g.last_at = ${ts.sinceIso}::timestamptz and (coalesce(g.email_key, ''), coalesce(g.phone, '')) < (${curEmail}, ${curPhone})))`,
        );
      }
    }
  }

  const res = await db.execute<GuestListRow>(sql`
    with ${guestCte(guestOrderWhere(filter))}
    select
      g.email_key, g.email, g.phone, g.name, g.order_count,
      g.paid_spend, g.total_spend, g.last_at, g.first_at, g.last_cursor,
      acct.id as account_user_id,
      acct.email_verified as account_verified,
      acct.customer_profile_id as account_profile_id
    from g
    ${acctJoin}
    where ${and(...outer)}
    order by g.last_at desc, coalesce(g.email_key, '') desc, coalesce(g.phone, '') desc
    limit ${limit + 1}
  `);

  const rows = res.rows;
  const hasMore = rows.length > limit;
  const trimmed = hasMore ? rows.slice(0, limit) : rows;
  const last = trimmed[trimmed.length - 1];
  return {
    items: trimmed.map((r) => ({
      // contact_email is NOT NULL, so an email-less guest carries '' (not null) —
      // normalize it to null here so the UI's `?? "—"` and the emailKey are clean.
      emailKey: r.email_key || null,
      email: r.email || null,
      phone: r.phone || null,
      name: r.name || null,
      orderCount: Number(r.order_count),
      paidSpendCents: Number(r.paid_spend),
      totalSpendCents: Number(r.total_spend),
      firstOrderAt: toIso(r.first_at),
      lastOrderAt: toIso(r.last_at),
      accountUserId: r.account_user_id,
      accountVerified: Boolean(r.account_verified),
      accountProfileId: r.account_profile_id,
    })),
    nextCursor:
      hasMore && last && last.last_cursor
        ? `${last.last_cursor}|${encodeURIComponent(last.email_key ?? "")}|${encodeURIComponent(last.phone ?? "")}`
        : null,
  };
}

type GuestStatsRow = {
  total: number;
  total_orders: string;
  paid_revenue: string;
  with_email: number;
  without_email: number;
  with_phone: number;
  with_account: number;
  repeat: number;
};

/** One aggregate pass over the FILTERED guest set — every card reflects the active filter. */
export async function guestFilterStats(filter: GuestFilter): Promise<GuestStats> {
  const res = await db.execute<GuestStatsRow>(sql`
    with ${guestCte(guestOrderWhere(filter))},
    j as (
      select g.email_key, g.phone, g.order_count, g.paid_spend, acct.id as account_user_id
      from g
      ${acctJoin}
      where ${and(...guestOuterWhere(filter))}
    )
    select
      count(*)::int as total,
      coalesce(sum(order_count), 0)::bigint as total_orders,
      coalesce(sum(paid_spend), 0)::bigint as paid_revenue,
      count(*) filter (where email_key is not null and email_key <> '')::int as with_email,
      count(*) filter (where email_key is null or email_key = '')::int as without_email,
      count(*) filter (where phone is not null and phone <> '')::int as with_phone,
      count(*) filter (where account_user_id is not null)::int as with_account,
      count(*) filter (where order_count >= 2)::int as repeat
    from j
  `);
  const r = res.rows[0];
  const total = Number(r?.total ?? 0);
  const withEmail = Number(r?.with_email ?? 0);
  return {
    total,
    totalOrders: Number(r?.total_orders ?? 0),
    paidRevenueCents: Number(r?.paid_revenue ?? 0),
    withEmail,
    withoutEmail: Number(r?.without_email ?? 0),
    withPhone: Number(r?.with_phone ?? 0),
    withAccount: Number(r?.with_account ?? 0),
    repeat: Number(r?.repeat ?? 0),
  };
}
