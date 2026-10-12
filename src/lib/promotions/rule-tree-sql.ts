import "server-only";

import { sql, type SQL } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { isLeapYear } from "./segment-rules";
import { storeDay, storeMonth, storeYear } from "./segments";
import {
  anniversaryMdPairsWindow,
  isGroup,
  type RuleLeaf,
  type RuleNode,
} from "./rule-tree";
import { ruleTreeNeeds } from "./rule-leaves";

/**
 * SET-BASED evaluator for the compound rule tree — compiles a tree to a parameterized
 * SQL `WHERE` over the canonical customer base, for whole-audience mailing, per-segment
 * stats and CSV export (the per-checkout in-memory twin is `ruleTreeMatches` in
 * rule-leaves.ts). The SAME leaf KINDS drive both; the parity test
 * (segment-rule-tree-sql.test.ts) proves `toSql` and `matches` agree on every leaf —
 * the load-bearing anti-drift invariant.
 *
 * The base is `customer_profiles p JOIN customer_user_links cul JOIN users u`
 * (deleted_at IS NULL). Every leaf fragment is wrapped in `coalesce(<frag>, false)` so
 * a NULL (e.g. no cart) reads as FALSE exactly like the JS predicate — keeping NOT and
 * AND/OR parity-clean. Cart leaves reference the `cart` alias, added by a single
 * conditional LEFT JOIN LATERAL only when the tree needs it.
 */

const PLACED_ORDER_STATUSES = sql`('paid','preparing','shipped','delivered')`;

export type SegmentSqlCtx = {
  /** Store-TZ reference date 'YYYY-MM-DD' (birthday/anniversary/age math). */
  refYmd: string;
  refYear: number;
  refMonth: number;
  refDay: number;
  /** Reference instant ISO (cart / account age = whole days since). */
  refTsIso: string;
};

const pad = (n: number) => String(n).padStart(2, "0");
/** Mirror rule-leaves.ts `nnInt(v) ?? 0` EXACTLY, so the anniversary window bounds
 *  coerce identically on both evaluators (parity: a non-numeric/negative daysAfter → 0). */
const nnIntOr0 = (v: unknown): number =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.trunc(v) : 0;

/** Build the resolve context once (the store-TZ reference date). */
export async function buildSegmentSqlCtx(now: Date = new Date()): Promise<SegmentSqlCtx> {
  const y = storeYear(now);
  const m = storeMonth(now);
  const d = storeDay(now);
  return {
    refYmd: `${y}-${pad(m)}-${pad(d)}`,
    refYear: y,
    refMonth: m,
    refDay: d,
    refTsIso: now.toISOString(),
  };
}

/** `(extract(month from col), extract(day from col)) IN ((m,d), …)` — or `false` when empty. */
function mdPairsIn(col: SQL, pairs: Array<[number, number]>): SQL {
  if (pairs.length === 0) return sql`false`;
  const list = sql.join(pairs.map(([m, d]) => sql`(${m},${d})`), sql`, `);
  return sql`(extract(month from ${col}), extract(day from ${col})) in (${list})`;
}

/** One leaf → a boolean SQL fragment (raw; ruleTreeToSql wraps it in coalesce(...,false)). */
function leafToSql(leaf: RuleLeaf, ctx: SegmentSqlCtx): SQL {
  const cartAgeDays = sql`floor(extract(epoch from (${ctx.refTsIso}::timestamptz - cart.last_activity)) / 86400)`;
  switch (leaf.kind) {
    case "has_orders": return sql`exists (select 1 from orders o where o.user_id = u.id and o.status in ${PLACED_ORDER_STATUSES})`;
    case "no_orders": return sql`not exists (select 1 from orders o where o.user_id = u.id and o.status in ${PLACED_ORDER_STATUSES})`;
    case "cart_has_items": return sql`cart.units > 0`;
    case "cart_total_gte": return sql`cart.total_cents >= ${Number(leaf.cents)}`;
    case "cart_total_lte": return sql`cart.total_cents <= ${Number(leaf.cents)}`;
    case "cart_age_gte_days": return sql`${cartAgeDays} >= ${Number(leaf.days)}`;
    case "cart_age_lte_days": return sql`${cartAgeDays} <= ${Number(leaf.days)}`;
    case "cart_item_count": {
      const col = leaf.distinct ? sql`cart.lines` : sql`cart.units`;
      const c = Number(leaf.count);
      return leaf.op === "gte" ? sql`${col} >= ${c}` : leaf.op === "lte" ? sql`${col} <= ${c}` : sql`${col} = ${c}`;
    }
    // Calendar age = whole years elapsed (Postgres age()), matching the JS predicate.
    case "age_gte": return sql`p.birthday is not null and date_part('year', age(${ctx.refYmd}::date, p.birthday)) >= ${Number(leaf.years)}`;
    case "age_lte": return sql`p.birthday is not null and date_part('year', age(${ctx.refYmd}::date, p.birthday)) <= ${Number(leaf.years)}`;
    case "gender": return sql`p.gender = ${String(leaf.value)}`;
    case "account_age_gte_days": return sql`floor(extract(epoch from (${ctx.refTsIso}::timestamptz - p.created_at)) / 86400) >= ${Number(leaf.days)}`;
    case "account_age_lte_days": return sql`floor(extract(epoch from (${ctx.refTsIso}::timestamptz - p.created_at)) / 86400) <= ${Number(leaf.days)}`;
    case "birthday_anniversary":
      return sql`p.birthday is not null and ${mdPairsIn(sql`p.birthday`, anniversaryMdPairsWindow(ctx.refYmd, Number(leaf.daysBefore), nnIntOr0(leaf.daysAfter)))}`;
    case "birthday_month": return sql`p.birthday is not null and extract(month from p.birthday) = ${ctx.refMonth}`;
    case "birthday_today": {
      const base = sql`(extract(month from p.birthday) = ${ctx.refMonth} and extract(day from p.birthday) = ${ctx.refDay})`;
      // Feb-29 birthday celebrated on Feb-28 in a common year (matches the JS fold).
      const fold =
        ctx.refMonth === 2 && ctx.refDay === 28 && !isLeapYear(ctx.refYear)
          ? sql` or (extract(month from p.birthday) = 2 and extract(day from p.birthday) = 29)`
          : sql``;
      return sql`p.birthday is not null and (${base}${fold})`;
    }
    case "marketing_opted_in": return sql`p.marketing_opt_in`;
    case "never":
    default:
      return sql`false`;
  }
}

/** Compile a rule tree to a boolean SQL fragment over the base (p / u / cart aliases). */
export function ruleTreeToSql(node: RuleNode, ctx: SegmentSqlCtx): SQL {
  if (isGroup(node)) {
    const parts = node.children.map((c) => ruleTreeToSql(c, ctx));
    const joined = sql.join(parts, node.op === "and" ? sql` and ` : sql` or `);
    const body = sql`(${joined})`;
    return node.negate ? sql`(not ${body})` : body;
  }
  // NULL-safe: a missing fact (e.g. no cart) reads as FALSE, exactly like the predicate.
  const frag = sql`coalesce((${leafToSql(node, ctx)}), false)`;
  return node.negate ? sql`(not ${frag})` : frag;
}

/** The conditional cart LATERAL — the buyer's latest live cart's aggregates. */
function cartLateral(need: boolean): SQL {
  if (!need) return sql``;
  return sql`
    left join lateral (
      select
        sum(ci.unit_price_cents::bigint * ci.quantity) as total_cents,
        sum(ci.quantity) as units,
        count(*) as lines,
        greatest(c.updated_at, max(ci.updated_at)) as last_activity
      from carts c
      join cart_items ci on ci.cart_id = c.id
      where c.user_id = u.id and (c.token is null or c.token not like 'qb-%')
      group by c.id
      order by greatest(c.updated_at, max(ci.updated_at)) desc
      limit 1
    ) cart on true`;
}

/**
 * Resolve the profile ids a rule tree matches (newest first), capped. Used by mailing /
 * stats / export. Set-based — cart leaves run in one SQL pass.
 */
export async function segmentMemberIdsSql(
  node: RuleNode,
  ctx: SegmentSqlCtx,
  opts: { cap?: number; profileIds?: string[]; marketingOptInOnly?: boolean } = {},
): Promise<string[]> {
  // Optional scope: restrict to a candidate set (e.g. the promo audience's opt-in
  // profiles), so membership is resolved WITHIN a bounded list rather than the whole
  // base. An empty array means "no candidates" → no rows.
  if (opts.profileIds && opts.profileIds.length === 0) return [];
  const scope = opts.profileIds
    ? sql` and p.id in (${sql.join(opts.profileIds.map((id) => sql`${id}`), sql`, `)})`
    : sql``;
  // Optional opt-in gate BEFORE the cap, so a mailing's newest-N cap selects SENDABLE
  // members and truncation reflects the true sendable count (export leaves it off to
  // get the full roster).
  const optIn = opts.marketingOptInOnly ? sql` and p.marketing_opt_in = true` : sql``;
  const join = cartLateral(ruleTreeNeeds(node).has("cart"));
  const where = ruleTreeToSql(node, ctx);
  const cap = opts.cap && opts.cap > 0 ? sql` limit ${Math.floor(opts.cap)}` : sql``;
  const res = await db.execute(sql`
    select p.id
    from customer_profiles p
    join customer_user_links cul on cul.customer_profile_id = p.id
    join users u on u.id = cul.user_id${join}
    where p.deleted_at is null${scope}${optIn} and (${where})
    order by p.created_at desc, p.id desc${cap}
  `);
  return (res as unknown as { rows: Array<{ id: string }> }).rows.map((r) => r.id);
}

/** Count of matching members (for the per-segment stats card). */
export async function segmentCountSql(node: RuleNode, ctx: SegmentSqlCtx): Promise<number> {
  const join = cartLateral(ruleTreeNeeds(node).has("cart"));
  const where = ruleTreeToSql(node, ctx);
  const res = await db.execute(sql`
    select count(*)::int as n
    from customer_profiles p
    join customer_user_links cul on cul.customer_profile_id = p.id
    join users u on u.id = cul.user_id${join}
    where p.deleted_at is null and (${where})
  `);
  return Number((res as unknown as { rows: Array<{ n: number }> }).rows[0]?.n ?? 0);
}

/** Per-segment demographic breakdown (the admin « Statistiques » card). */
export type SegmentStats = {
  total: number;
  /** Members still marketing-opted-in (the mailable subset). */
  optedIn: number;
  female: number;
  male: number;
  otherGender: number;
  genderUnset: number;
};

/** The FILTER-aggregate columns — reused by the dynamic (SQL-compiled) and the
 *  manual (member-row) stats queries so both report the SAME shape off a `p` alias. */
export const SEGMENT_STATS_COLUMNS = sql`
  count(*)::int as total,
  count(*) filter (where p.marketing_opt_in)::int as opted_in,
  count(*) filter (where p.gender = 'female')::int as female,
  count(*) filter (where p.gender = 'male')::int as male,
  count(*) filter (where p.gender = 'other')::int as other_gender,
  count(*) filter (where p.gender is null)::int as gender_unset
`;

/** Normalize a SEGMENT_STATS_COLUMNS row. */
export function rowToSegmentStats(row: Record<string, unknown> | undefined): SegmentStats {
  return {
    total: Number(row?.total ?? 0),
    optedIn: Number(row?.opted_in ?? 0),
    female: Number(row?.female ?? 0),
    male: Number(row?.male ?? 0),
    otherGender: Number(row?.other_gender ?? 0),
    genderUnset: Number(row?.gender_unset ?? 0),
  };
}

/** Demographic breakdown of a DYNAMIC segment's live members — one aggregate pass. */
export async function segmentStatsSql(node: RuleNode, ctx: SegmentSqlCtx): Promise<SegmentStats> {
  const join = cartLateral(ruleTreeNeeds(node).has("cart"));
  const where = ruleTreeToSql(node, ctx);
  const res = await db.execute(sql`
    select ${SEGMENT_STATS_COLUMNS}
    from customer_profiles p
    join customer_user_links cul on cul.customer_profile_id = p.id
    join users u on u.id = cul.user_id${join}
    where p.deleted_at is null and (${where})
  `);
  return rowToSegmentStats((res as unknown as { rows: Array<Record<string, unknown>> }).rows[0]);
}
