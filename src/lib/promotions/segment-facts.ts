import "server-only";

import { sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import type { CustomerProfileRow } from "@/modules/customer/schema";
import type { LeafNeed, SegmentFacts } from "./rule-leaves";
import type { SegmentSqlCtx } from "./rule-tree-sql";

/**
 * Per-profile FACT LOADER for the compound rule tree — the in-memory twin of the
 * SET-BASED SQL compiler (rule-tree-sql.ts). `resolveSegmentIdsForProfile` (per
 * checkout) evaluates a buyer's dynamic-segment membership with `ruleTreeMatches`
 * over the facts this builds; the SQL compiler resolves the whole audience for
 * mailing/stats/export. Both MUST read the SAME source of truth so a segment means
 * the same thing at the till and in a blast — every expression here is deliberately
 * IDENTICAL to its counterpart in leafToSql (same store-TZ ref, same
 * latest-non-qb-cart selection, same epoch/86400 day math). The parity test
 * (segment-rule-tree-sql.test.ts) runs BOTH evaluators over the same fixtures and
 * asserts they agree, so any drift here fails CI.
 */

const DAY_MS = 86_400_000;

/** The profile columns the non-lazy facts read (the buyer context already has the
 *  full row). */
export type SegmentFactsProfile = Pick<
  CustomerProfileRow,
  | "id"
  | "marketing_opt_in"
  | "birthday"
  | "gender"
  | "created_at"
>;

/**
 * Calendar age in whole years — mirrors Postgres `date_part('year', age(ref, dob))`
 * for a reference on/after the birthday: full years elapsed, the current year not
 * counted until the month/day is reached.
 */
function calendarAgeYears(birthday: string, refYmd: string): number {
  const [by, bm, bd] = birthday.split("-").map(Number);
  const [ry, rm, rd] = refYmd.split("-").map(Number);
  let age = ry - by;
  if (rm < bm || (rm === bm && rd < bd)) age -= 1;
  return age;
}

/**
 * Build the buyer's SegmentFacts. `needs` (from `ruleTreeNeeds` over every enabled
 * dynamic segment's tree) gates the extra reads: orders/cart each run at most one
 * small indexed query, and only when some rule actually inspects them.
 */
export async function loadSegmentFacts(
  profile: SegmentFactsProfile,
  userId: string,
  needs: Set<LeafNeed>,
  ctx: SegmentSqlCtx,
): Promise<SegmentFacts> {
  const refTsMs = Date.parse(ctx.refTsIso);
  const accountAgeDays = profile.created_at
    ? Math.floor((refTsMs - new Date(profile.created_at).getTime()) / DAY_MS)
    : 0;

  let orderCount = 0;
  if (needs.has("orders")) {
    // Only GENUINELY-PLACED orders count (mirrors leafToSql's has_orders/no_orders):
    // a pending/refunded order must not make a first-timer look like a returning buyer.
    const res = await db.execute(
      sql`select count(*)::int as n from orders where user_id = ${userId} and status in ('paid','preparing','shipped','delivered')`,
    );
    orderCount = Number((res as unknown as { rows: Array<{ n: number }> }).rows[0]?.n ?? 0);
  }

  let cart: SegmentFacts["cart"] = null;
  if (needs.has("cart")) {
    // The buyer's latest LIVE cart (quick-buy 'qb-' carts excluded), aggregated the
    // SAME way as cartLateral — age_days computed in-SQL off ctx.refTsIso so the
    // floor(epoch/86400) rounding is byte-for-byte the compiler's.
    const res = await db.execute(sql`
      select
        sum(ci.unit_price_cents::bigint * ci.quantity) as total_cents,
        sum(ci.quantity) as units,
        count(*) as lines,
        floor(extract(epoch from (${ctx.refTsIso}::timestamptz - greatest(c.updated_at, max(ci.updated_at)))) / 86400) as age_days
      from carts c
      join cart_items ci on ci.cart_id = c.id
      where c.user_id = ${userId} and (c.token is null or c.token not like 'qb-%')
      group by c.id
      order by greatest(c.updated_at, max(ci.updated_at)) desc
      limit 1
    `);
    const row = (res as unknown as {
      rows: Array<{ total_cents: string | number; units: string | number; lines: string | number; age_days: string | number }>;
    }).rows[0];
    if (row) {
      cart = {
        totalCents: Number(row.total_cents),
        itemUnits: Number(row.units),
        itemLines: Number(row.lines),
        ageDays: Number(row.age_days),
      };
    }
  }

  return {
    orderCount,
    marketingOptIn: profile.marketing_opt_in,
    birthday: profile.birthday ?? null,
    ageYears: profile.birthday ? calendarAgeYears(profile.birthday, ctx.refYmd) : null,
    gender: profile.gender ?? null,
    accountAgeDays,
    cart,
    ref: { ymd: ctx.refYmd, year: ctx.refYear, month: ctx.refMonth, day: ctx.refDay },
  };
}
