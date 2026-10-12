import "server-only";

import { and, desc, eq, ilike, inArray, isNull, or, sql } from "drizzle-orm";

import { db, type DbOrTx } from "@/lib/db/client";
import { parseIncrementalCursor, UUID_RE } from "@/lib/api/cursor";
import { keysetCursor } from "@/lib/api/keyset";
import { users } from "@/modules/auth/schema";
import { customer_profiles, type CustomerProfileRow } from "@/modules/customer/schema";
import {
  customer_user_links,
  type CustomerUserLinkRow,
  type NewCustomerUserLinkRow,
} from "./customer-user";

/**
 * Helper for the customer_user_links join table.
 *
 * Lives in `src/associations/` (not a module) because it's the bridge
 * between auth and customer. Workflows that span both modules use this —
 * including the admin Clients search, which must match across the customer
 * profile (name, phone) AND the linked auth user (email) in one query.
 */

class CustomerUserLink {
  async create(input: NewCustomerUserLinkRow): Promise<CustomerUserLinkRow> {
    const [row] = await db.insert(customer_user_links).values(input).returning();
    return row;
  }

  /**
   * `txOrDb`: pass the caller's `tx` when called INSIDE a transaction (e.g. the
   * cancel / full-refund coins reconciliation) — the pool default would take a
   * second connection while the tx holds one plus its row locks.
   */
  async findByUserId(userId: string, txOrDb: DbOrTx = db): Promise<CustomerUserLinkRow | null> {
    const [row] = await txOrDb
      .select()
      .from(customer_user_links)
      .where(eq(customer_user_links.user_id, userId))
      .limit(1);
    return row ?? null;
  }

  /** Batch user_id → customer_profile_id map (admin surfaces that list several
   *  users at once — e.g. the carts list linking each cart to its customer 360). */
  async profileIdsByUserIds(
    userIds: string[],
    txOrDb: DbOrTx = db,
  ): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    if (userIds.length === 0) return map;
    const rows = await txOrDb
      .select({
        userId: customer_user_links.user_id,
        profileId: customer_user_links.customer_profile_id,
      })
      .from(customer_user_links)
      .where(inArray(customer_user_links.user_id, userIds));
    for (const r of rows) map.set(r.userId, r.profileId);
    return map;
  }

  async findByProfileId(
    profileId: string,
    txOrDb: DbOrTx = db,
  ): Promise<CustomerUserLinkRow | null> {
    const [row] = await txOrDb
      .select()
      .from(customer_user_links)
      .where(eq(customer_user_links.customer_profile_id, profileId))
      .limit(1);
    return row ?? null;
  }

  /**
   * Batch lookup for admin listing views that need to resolve many profile
   * ids to their linked user ids in one round-trip. Returns a Map keyed by
   * profile id; profiles without a linked user are simply absent.
   */
  async findByProfileIds(ids: string[]): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();
    const rows = await db
      .select()
      .from(customer_user_links)
      .where(inArray(customer_user_links.customer_profile_id, ids));
    return new Map(rows.map((r) => [r.customer_profile_id, r.user_id]));
  }

  /**
   * Reverse of `findByProfileIds` — batch-resolve many USER ids to their linked
   * customer profile (id + LIVE name) in one round-trip. Returns a Map keyed by
   * user id; users without a (non-deleted) profile are simply absent. Lets the
   * admin Utilisateurs list (a) link a customer-account row straight to its 360
   * and show a "Client" badge, and (b) render the CURRENT profile name rather
   * than the denormalised `users.name` (which can lag behind a profile rename —
   * the live join is drift-proof and costs no extra query). No N+1, no per-row hop.
   */
  async findProfileSummariesByUserIds(
    ids: string[],
  ): Promise<Map<string, { profileId: string; firstName: string; lastName: string }>> {
    if (ids.length === 0) return new Map();
    const rows = await db
      .select({
        userId: customer_user_links.user_id,
        profileId: customer_user_links.customer_profile_id,
        firstName: customer_profiles.first_name,
        lastName: customer_profiles.last_name,
      })
      .from(customer_user_links)
      .innerJoin(
        customer_profiles,
        eq(customer_profiles.id, customer_user_links.customer_profile_id),
      )
      .where(and(inArray(customer_user_links.user_id, ids), isNull(customer_profiles.deleted_at)));
    return new Map(
      rows.map((r) => [
        r.userId,
        { profileId: r.profileId, firstName: r.firstName, lastName: r.lastName },
      ]),
    );
  }

  /**
   * Admin Clients search — matches a single query against the customer's NAME
   * (first/last), their linked account's EMAIL, and their normalized PHONE
   * (digits-only, so "+216 12 345 678" matches "12345678"). LEFT JOIN to the
   * link + user so profiles with no account still list (email simply won't
   * match them). Keyset pagination on created_at desc. Returns the profile row
   * plus the resolved userId/email so the caller skips a second round-trip.
   */
  async searchCustomersForAdmin(opts: {
    search?: string;
    limit?: number;
    cursor?: string;
  } = {}): Promise<{
    items: Array<{ profile: CustomerProfileRow; userId: string | null; email: string | null }>;
    nextCursor: string | null;
  }> {
    const limit = Math.min(opts.limit ?? 50, 200);
    const conditions = [isNull(customer_profiles.deleted_at)];

    const q = opts.search?.trim();
    if (q) {
      const digits = q.replace(/\D/g, "");
      // Resolve the EMAIL match via a separate INDEXED scan over users
      // (users_email_trgm) → linked customer_profile_ids, rather than OR-ing a
      // left-joined `users.email` predicate into the main WHERE. Mixing a
      // joined-relation column into the disjunction forced Postgres to build the
      // joins first and apply the whole OR as a post-join Seq Scan on
      // customer_profiles, defeating the first_name/last_name/phone trigram
      // indexes (DB-PERF-1). With email pre-resolved to ids, the main WHERE
      // references only customer_profiles columns, so the planner can BitmapOr
      // the trigram indexes. Capped to keep the IN-list bounded; a fragment
      // matching 5000+ emails is not a realistic admin search.
      const emailRows = await db
        .select({ profileId: customer_user_links.customer_profile_id })
        .from(users)
        .innerJoin(customer_user_links, eq(customer_user_links.user_id, users.id))
        .where(ilike(users.email, `%${q}%`))
        .limit(5000);
      const emailProfileIds = emailRows.map((r) => r.profileId);

      const matchers = [
        ilike(customer_profiles.first_name, `%${q}%`),
        ilike(customer_profiles.last_name, `%${q}%`),
      ];
      // Only treat the query as a phone fragment when it has ≥2 digits, so a
      // text search isn't polluted by an incidental digit.
      if (digits.length >= 2) {
        matchers.push(ilike(customer_profiles.phone_normalized, `%${digits}%`));
      }
      if (emailProfileIds.length > 0) {
        matchers.push(inArray(customer_profiles.id, emailProfileIds));
      }
      conditions.push(or(...matchers)!);
    }
    // COMPOUND keyset (created_at, id): created_at alone is not unique, so a
    // plain `lt(created_at)` cursor silently SKIPS rows that share the boundary
    // timestamp (e.g. a bulk import inserting many profiles in one instant). The
    // id tie-breaker makes pagination total. Cursor encodes both as
    // "<iso>|<uuid>", the timestamp µs-FAITHFUL (`keysetCursor`, bound back as a
    // raw `::timestamptz` cast — a JS-Date cursor truncated .123456 → .123 and
    // skipped the rest of the boundary millisecond). The cursor comes back from
    // the client, so it's gated like `customerService.list`: a malformed /
    // forged one (bad date → Invalid Date `toISOString()` RangeError, bad id →
    // 22P02) falls back to the first page instead of a 500.
    if (opts.cursor) {
      const sep = opts.cursor.lastIndexOf("|");
      const curTs = sep >= 0 ? opts.cursor.slice(0, sep) : opts.cursor;
      const curId = sep >= 0 ? opts.cursor.slice(sep + 1) : undefined;
      const ts = parseIncrementalCursor(new URLSearchParams({ since: curTs }));
      if (ts.ok && ts.sinceIso && (curId === undefined || UUID_RE.test(curId))) {
        conditions.push(
          curId
            ? sql`(${customer_profiles.created_at} < ${ts.sinceIso}::timestamptz OR (${customer_profiles.created_at} = ${ts.sinceIso}::timestamptz AND ${customer_profiles.id} < ${curId}::uuid))`
            : sql`${customer_profiles.created_at} < ${ts.sinceIso}::timestamptz`,
        );
      }
    }

    const rows = await db
      .select({
        profile: customer_profiles,
        userId: customer_user_links.user_id,
        email: users.email,
        cursor: keysetCursor(customer_profiles.created_at),
      })
      .from(customer_profiles)
      .leftJoin(
        customer_user_links,
        eq(customer_user_links.customer_profile_id, customer_profiles.id),
      )
      .leftJoin(users, eq(users.id, customer_user_links.user_id))
      .where(and(...conditions))
      .orderBy(desc(customer_profiles.created_at), desc(customer_profiles.id))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const trimmed = hasMore ? rows.slice(0, limit) : rows;
    const last = trimmed[trimmed.length - 1];
    return {
      items: trimmed.map((r) => ({ profile: r.profile, userId: r.userId, email: r.email })),
      nextCursor: hasMore && last ? `${last.cursor}|${last.profile.id}` : null,
    };
  }
}

export const customerUserLink = new CustomerUserLink();
