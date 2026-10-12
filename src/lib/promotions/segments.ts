import "server-only";

import { and, eq, isNull } from "drizzle-orm";

import { db } from "@/lib/db/client";
import {
  customer_segment_members,
  customer_segments,
} from "@/modules/customer/schema";
import { customerUserLink } from "@/associations/customer-user.service";
import { customerService } from "@/modules/customer/service";
import { legacyRuleToTree, type RuleNode } from "@/lib/promotions/rule-tree";
import { ruleTreeMatches, ruleTreeNeeds, type LeafNeed } from "@/lib/promotions/rule-leaves";
import { buildSegmentSqlCtx } from "@/lib/promotions/rule-tree-sql";
import { loadSegmentFacts, type SegmentFactsProfile } from "@/lib/promotions/segment-facts";

/** Store timezone — birthday_month compares against the month HERE, not the
 *  container's ambient TZ, so the rule behaves identically wherever it's
 *  deployed (Coolify containers usually run UTC; the shop is Tunisia, UTC+1). */
const STORE_TIME_ZONE = "Africa/Tunis";

/**
 * Current month (1-12) in the store's timezone — the reference frame the
 * `birthday_month` rule compares a buyer's birthday month against. Pass `ref`
 * to evaluate a fixed instant (deterministic tests); defaults to now. Exported
 * so tests build birthday fixtures in the SAME frame the resolver uses.
 */
export function storeMonth(ref: Date = new Date()): number {
  return Number(
    new Intl.DateTimeFormat("en-CA", { timeZone: STORE_TIME_ZONE, month: "numeric" }).format(ref),
  );
}

/** Current day-of-month (1-31) in the store's timezone — drives birthday_today. */
export function storeDay(ref: Date = new Date()): number {
  return Number(
    new Intl.DateTimeFormat("en-CA", { timeZone: STORE_TIME_ZONE, day: "numeric" }).format(ref),
  );
}

/** Current year in the store's timezone — lets birthday_today fold Feb-29. */
export function storeYear(ref: Date = new Date()): number {
  return Number(
    new Intl.DateTimeFormat("en-CA", { timeZone: STORE_TIME_ZONE, year: "numeric" }).format(ref),
  );
}

/**
 * Customer SEGMENTS — reusable groupings a promotion can target (migration 0042).
 *
 *   - MANUAL segments have explicit member rows (customer_segment_members).
 *   - DYNAMIC segments carry a compound `rule_tree` (AND/OR/NOT over leaf
 *     conditions — see rule-leaves.ts) evaluated at request-time against the
 *     buyer's facts (no member rows). A legacy single `rule` string still resolves
 *     through the SAME engine via `legacyRuleToTree` (no DB backfill needed).
 *
 * Resolution is done ONCE per cart/checkout (in the buyer-context resolver),
 * never per line — so the few queries here are off the hot per-line path. The
 * whole-audience twin (mailing/stats/export) is the SQL compiler in
 * rule-tree-sql.ts; both key off the same leaf registry and a parity test keeps
 * them in lockstep.
 */

/**
 * The set of segment ids a customer belongs to right now — manual memberships
 * plus every enabled dynamic segment whose rule tree matches. Used by the buyer
 * context for promotion targeting. `opts.now` overrides the reference date
 * (default: now) so the store-TZ anniversary/birthday rules are deterministically
 * testable.
 */
export async function resolveSegmentIdsForProfile(
  profile: SegmentFactsProfile,
  userId: string,
  opts: { now?: Date } = {},
): Promise<string[]> {
  // Manual memberships — JOIN the segment so a DISABLED or soft-deleted manual
  // segment stops matching (mirrors the dynamic branch's enabled+deleted_at
  // filter; without this, disabling a manual segment was a silent no-op and its
  // members kept getting the targeted discount).
  const manual = await db
    .select({ id: customer_segment_members.segment_id })
    .from(customer_segment_members)
    .innerJoin(
      customer_segments,
      eq(customer_segments.id, customer_segment_members.segment_id),
    )
    .where(
      and(
        eq(customer_segment_members.customer_profile_id, profile.id),
        eq(customer_segments.enabled, true),
        isNull(customer_segments.deleted_at),
      ),
    );
  const manualIds = manual.map((m) => m.id);

  // Enabled dynamic segments — evaluate each tree in memory.
  const dyn = await db
    .select({ id: customer_segments.id, rule: customer_segments.rule, rule_tree: customer_segments.rule_tree })
    .from(customer_segments)
    .where(
      and(
        eq(customer_segments.kind, "dynamic"),
        eq(customer_segments.enabled, true),
        isNull(customer_segments.deleted_at),
      ),
    );
  if (dyn.length === 0) return manualIds;

  // A compound rule_tree wins; a legacy single rule maps to a one-leaf tree.
  const trees = dyn.map((d) => ({ id: d.id, tree: d.rule_tree ?? legacyRuleToTree(d.rule) }));
  // Only load the facts some present rule actually inspects (orders/cart).
  const needs = new Set<LeafNeed>();
  for (const t of trees) for (const n of ruleTreeNeeds(t.tree)) needs.add(n);

  const ctx = await buildSegmentSqlCtx(opts.now);
  const facts = await loadSegmentFacts(profile, userId, needs, ctx);
  const dynIds = trees
    .filter((t: { id: string; tree: RuleNode }) => ruleTreeMatches(t.tree, facts))
    .map((t) => t.id);
  return [...manualIds, ...dynIds];
}

/**
 * Does this buyer's facts satisfy an INLINE promotion audience rule? Loads only the
 * facts the tree's leaves inspect (`ruleTreeNeeds`) and evaluates `ruleTreeMatches`
 * — the SAME per-buyer predicate used for dynamic segments. `opts.now` overrides the
 * reference date (deterministic anniversary/birthday tests).
 */
export async function profileMatchesRuleTree(
  profile: SegmentFactsProfile,
  userId: string,
  tree: RuleNode,
  opts: { now?: Date } = {},
): Promise<boolean> {
  const needs = new Set<LeafNeed>();
  for (const n of ruleTreeNeeds(tree)) needs.add(n);
  const ctx = await buildSegmentSqlCtx(opts.now);
  const facts = await loadSegmentFacts(profile, userId, needs, ctx);
  return ruleTreeMatches(tree, facts);
}

/**
 * userId-keyed convenience for the coupon eligibility path: resolve the buyer's
 * profile then evaluate an inline promo audience rule. A GUEST (no linked profile)
 * matches NO fact-based audience → false (a fact rule needs a customer identity).
 */
export async function userMatchesRuleTree(
  userId: string | null,
  tree: RuleNode,
  opts: { now?: Date } = {},
): Promise<boolean> {
  if (!userId) return false;
  const link = await customerUserLink.findByUserId(userId).catch(() => null);
  const profile = link
    ? await customerService.findProfileById(link.customer_profile_id).catch(() => null)
    : null;
  if (!profile) return false;
  return profileMatchesRuleTree(profile, userId, tree, opts);
}
