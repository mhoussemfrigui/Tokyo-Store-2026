import "server-only";

import { and, desc, eq, ilike, sql, type SQL } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { customer_profiles, type CustomerProfileRow } from "@/modules/customer/schema";
import { customer_user_links } from "@/associations/customer-user";
import { users } from "@/modules/auth/schema";
import { authService } from "@/modules/auth/service";
import { customerUserLink } from "@/associations/customer-user.service";
import { parseIncrementalCursor, UUID_RE } from "@/lib/api/cursor";
import { keysetCursor } from "@/lib/api/keyset";
import { STORE_TIME_ZONE } from "@/lib/time/store-tz";
import type { CustomerFilter, CustomerFilterStats, FilteredCustomerRow } from "./filter-shared";

/**
 * SERVER-side application of the Clients-list filter (./filter-shared.ts). Powers the
 * search action (keyset-paginated list), the filterable stats header, and the filtered
 * CSV export — all off ONE conditions builder, so what you see, count and export always
 * agree. Boolean-ish dimensions that reach other tables (orders/cart/coupons) are
 * correlated EXISTS on the profile → its linked user, matching the same join keys the
 * segment engine uses (indexed). The base table is referenced by its real name
 * `customer_profiles` (no alias) so the drizzle list query and the raw-SQL stats query
 * share the SAME correlated fragments.
 */

// ── correlated EXISTS fragments (correlate on the outer customer_profiles.id) ──
const couponExists = sql`exists (select 1 from customer_user_links cul join promotion_redemptions pr on pr.user_id = cul.user_id where cul.customer_profile_id = customer_profiles.id)`;
const cartExists = sql`exists (select 1 from customer_user_links cul join carts c on c.user_id = cul.user_id join cart_items ci on ci.cart_id = c.id where cul.customer_profile_id = customer_profiles.id and (c.token is null or c.token not like 'qb-%'))`;

const tri = (frag: SQL, state: "yes" | "no") => (state === "yes" ? frag : sql`not ${frag}`);
const YMD = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Build the WHERE conditions for `customer_profiles`. Async because a name/email/phone
 * search pre-resolves matching email→profile ids via an INDEXED users scan (so the
 * main WHERE keeps only customer_profiles columns and the trigram indexes stay usable —
 * same trick as searchCustomersForAdmin).
 */
export async function customerFilterConditions(f: CustomerFilter): Promise<SQL[]> {
  const c: SQL[] = [sql`customer_profiles.deleted_at is null`];

  const q = f.search.trim();
  if (q) {
    const digits = q.replace(/\D/g, "");
    // ORDER BY users.id so the capped slice is DETERMINISTIC: this runs once per
    // list page, once for the stats aggregate, and once per export page, and all
    // of them must fold in the SAME id-set or list/stats/export desync (an
    // unordered LIMIT returns a different arbitrary slice each call).
    const emailRows = await db
      .select({ pid: customer_user_links.customer_profile_id })
      .from(users)
      .innerJoin(customer_user_links, eq(customer_user_links.user_id, users.id))
      .where(ilike(users.email, `%${q}%`))
      .orderBy(users.id)
      .limit(5000);
    const emailPids = emailRows.map((r) => r.pid);
    const matchers: SQL[] = [
      sql`customer_profiles.first_name ilike ${`%${q}%`}`,
      sql`customer_profiles.last_name ilike ${`%${q}%`}`,
    ];
    if (digits.length >= 2) matchers.push(sql`customer_profiles.phone_normalized ilike ${`%${digits}%`}`);
    if (emailPids.length > 0)
      matchers.push(sql`customer_profiles.id in (${sql.join(emailPids.map((id) => sql`${id}`), sql`, `)})`);
    c.push(sql`(${sql.join(matchers, sql` or `)})`);
  }

  if (f.gender === "unset") c.push(sql`customer_profiles.gender is null`);
  else if (f.gender === "known") c.push(sql`customer_profiles.gender is not null`);
  else if (f.gender !== "any") c.push(sql`customer_profiles.gender = ${f.gender}`);

  if (f.marketing !== "any") c.push(sql`customer_profiles.marketing_opt_in = ${f.marketing === "yes"}`);
  if (f.usedCoupon !== "any") c.push(tri(couponExists, f.usedCoupon));
  if (f.hasCart !== "any") c.push(tri(cartExists, f.hasCart));

  // The picked days are read by the admin in the STORE zone (Africa/Tunis), so anchor
  // the day boundaries there, not at the DB session's UTC midnight — otherwise every
  // registration in the 23:00–24:00 UTC band lands on the wrong calendar day.
  if (YMD.test(f.createdFrom))
    c.push(sql`customer_profiles.created_at >= (${f.createdFrom}::date at time zone ${STORE_TIME_ZONE})`);
  if (YMD.test(f.createdTo))
    c.push(sql`customer_profiles.created_at < ((${f.createdTo}::date + interval '1 day') at time zone ${STORE_TIME_ZONE})`);
  const month = Number(f.birthdayMonth);
  if (Number.isInteger(month) && month >= 1 && month <= 12)
    c.push(sql`extract(month from customer_profiles.birthday) = ${month}`);

  return c;
}

/** Resolve profile-id → email in two indexed steps (profile→user, user→email). */
async function emailsByProfileIds(profileIds: string[]): Promise<Map<string, string>> {
  if (profileIds.length === 0) return new Map();
  const linkMap = await customerUserLink.findByProfileIds(profileIds); // profileId → userId
  const emailMap = await authService.listEmailsByIds([...new Set(linkMap.values())]); // userId → email
  const out = new Map<string, string>();
  for (const [pid, uid] of linkMap) {
    const email = emailMap.get(uid);
    if (email) out.set(pid, email);
  }
  return out;
}

/** Core keyset page over the filtered base → raw CustomerProfileRow items (same shape
 *  as customerService.list, so the export route is a drop-in swap). */
async function filteredProfilesPage(
  filter: CustomerFilter,
  opts: { cursor?: string; limit?: number } = {},
): Promise<{ items: CustomerProfileRow[]; nextCursor: string | null }> {
  const limit = Math.min(opts.limit ?? 30, 200);
  const conditions = await customerFilterConditions(filter);

  if (opts.cursor) {
    const sep = opts.cursor.lastIndexOf("|");
    const curTs = sep >= 0 ? opts.cursor.slice(0, sep) : opts.cursor;
    const curId = sep >= 0 ? opts.cursor.slice(sep + 1) : undefined;
    const ts = parseIncrementalCursor(new URLSearchParams({ since: curTs }));
    if (ts.ok && ts.sinceIso && (curId === undefined || UUID_RE.test(curId))) {
      conditions.push(
        curId
          ? sql`(customer_profiles.created_at < ${ts.sinceIso}::timestamptz OR (customer_profiles.created_at = ${ts.sinceIso}::timestamptz AND customer_profiles.id < ${curId}::uuid))`
          : sql`customer_profiles.created_at < ${ts.sinceIso}::timestamptz`,
      );
    }
  }

  const rows = await db
    .select({ row: customer_profiles, cursor: keysetCursor(customer_profiles.created_at) })
    .from(customer_profiles)
    .where(and(...conditions))
    .orderBy(desc(customer_profiles.created_at), desc(customer_profiles.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const trimmed = hasMore ? rows.slice(0, limit) : rows;
  const last = trimmed[trimmed.length - 1];
  return {
    items: trimmed.map((r) => r.row),
    nextCursor: hasMore && last ? `${last.cursor}|${last.row.id}` : null,
  };
}

/** Keyset-paginated filtered list for the admin UI, e-mail enriched. */
export async function listFilteredCustomers(
  filter: CustomerFilter,
  opts: { cursor?: string; limit?: number } = {},
): Promise<{ rows: FilteredCustomerRow[]; nextCursor: string | null }> {
  const { items, nextCursor } = await filteredProfilesPage(filter, opts);
  const emailMap = await emailsByProfileIds(items.map((r) => r.id));
  return {
    rows: items.map((row) => ({
      profileId: row.id,
      firstName: row.first_name,
      lastName: row.last_name,
      email: emailMap.get(row.id) ?? null,
      phone: row.phone,
      gender: row.gender,
      createdAt: row.created_at.toISOString(),
    })),
    nextCursor,
  };
}

/** Raw filtered profiles (CustomerProfileRow) for the CSV export route — mirrors
 *  customerService.list's {items,nextCursor} so collectKeysetPages can page it. */
export async function listFilteredCustomerProfiles(
  filter: CustomerFilter,
  opts: { cursor?: string; limit?: number } = {},
): Promise<{ items: CustomerProfileRow[]; nextCursor: string | null }> {
  return filteredProfilesPage(filter, opts);
}

/** One aggregate pass over the FILTERED base — every card reflects the active filter. */
export async function customerFilterStats(filter: CustomerFilter): Promise<CustomerFilterStats> {
  const conditions = await customerFilterConditions(filter);
  const res = await db.execute(sql`
    select
      count(*)::int as total,
      count(*) filter (where customer_profiles.gender is not null)::int as gender_known,
      count(*) filter (where customer_profiles.gender = 'female')::int as female,
      count(*) filter (where customer_profiles.gender = 'male')::int as male,
      count(*) filter (where customer_profiles.gender = 'other')::int as other_gender,
      count(*) filter (where customer_profiles.marketing_opt_in)::int as marketing,
      count(*) filter (where ${cartExists})::int as with_cart,
      count(*) filter (where ${couponExists})::int as used_coupon
    from customer_profiles
    where ${and(...conditions)}
  `);
  const r = (res as unknown as { rows: Array<Record<string, number>> }).rows[0] ?? {};
  const total = Number(r.total ?? 0);
  const genderKnown = Number(r.gender_known ?? 0);
  return {
    total,
    genderKnown,
    genderUnset: total - genderKnown,
    female: Number(r.female ?? 0),
    male: Number(r.male ?? 0),
    otherGender: Number(r.other_gender ?? 0),
    marketing: Number(r.marketing ?? 0),
    withCart: Number(r.with_cart ?? 0),
    usedCoupon: Number(r.used_coupon ?? 0),
  };
}
