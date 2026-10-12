/**
 * Compound customer-segment rule TREE — PURE + client-safe (no DB, no "server-only")
 * so the admin builder (client) and both resolvers (per-checkout predicate + the
 * whole-audience SQL compiler) share ONE definition. A segment's `rule_tree` (migr
 * 0161, Phase 6c) is a boolean expression over leaf conditions; the leaf grammar +
 * matcher live in ./rule-leaves.ts. This module owns the tree shape, the bounds, the
 * anniversary date helpers, and the legacy single-`rule` → tree shim.
 */
import { isLeapYear } from "./segment-rules";

/** A single condition, e.g. { kind: "cart_total_gte", cents: 150000 }. Params are per-kind
 *  (see rule-leaves.ts LEAVES[kind]). `negate` inverts just this leaf. */
export type RuleLeaf = { kind: string; negate?: boolean } & Record<string, unknown>;

/** A boolean group over children. `negate` inverts the whole group (NOT). */
export type RuleGroup = { op: "and" | "or"; children: RuleNode[]; negate?: boolean };

export type RuleNode = RuleGroup | RuleLeaf;

export function isGroup(node: RuleNode): node is RuleGroup {
  return (node as RuleGroup).op === "and" || (node as RuleGroup).op === "or";
}

// Bounds — fail-closed limits that keep a client-supplied tree (and its generated
// SQL) bounded, and block an EMPTY group (which would match EVERYBODY).
export const MAX_TREE_DEPTH = 4;
export const MAX_TREE_LEAVES = 24;
export const MIN_GROUP_CHILDREN = 1;
export const MAX_GROUP_CHILDREN = 12;

// ─────────────────────────────────────────────────── anniversary date math (pure)

function ymdToUTC(ymd: string): number {
  return Date.parse(`${ymd}T00:00:00Z`);
}
/** UTC ms for `year`'s occurrence of the anchor's MM-DD, folding Feb-29 → Feb-28 in a
 *  common (non-leap) year so a leap-day anniversary still lands. */
function occurrenceUTC(anchor: string, year: number): number {
  const m = Number(anchor.slice(-5, -3));
  let d = Number(anchor.slice(-2));
  if (m === 2 && d === 29 && !isLeapYear(year)) d = 28;
  return Date.UTC(year, m - 1, d);
}

/**
 * Whole days from `refYmd` to the NEXT occurrence of the anchor's MM-DD (0 = today,
 * up to ~366). `anchor` may be 'YYYY-MM-DD' or 'MM-DD'. Pure — the caller supplies the
 * store-TZ reference date (no `new Date()` here) so it stays testable.
 */
export function daysUntilAnniversary(anchor: string, refYmd: string): number {
  const refT = ymdToUTC(refYmd);
  const refYear = Number(refYmd.slice(0, 4));
  let cand = occurrenceUTC(anchor, refYear);
  if (cand < refT) cand = occurrenceUTC(anchor, refYear + 1);
  return Math.round((cand - refT) / 86_400_000);
}
/**
 * The YEAR of the NEXT occurrence of the anchor's MM-DD from `refYmd` (0-day-away =
 * today's year). The stable dedup key for a recurring anniversary send: a window that
 * straddles Dec→Jan resolves to the SAME occurrence year on both sides of the boundary,
 * so a customer reached in late December and again in early January claims one key —
 * no double-send. Pure (caller supplies the store-TZ reference date).
 */
export function anniversaryOccurrenceYear(anchor: string, refYmd: string): number {
  const refT = ymdToUTC(refYmd);
  const days = daysUntilAnniversary(anchor, refYmd);
  return new Date(refT + days * 86_400_000).getUTCFullYear();
}

/** Whole days SINCE the most-recent past (or today's) occurrence of the anchor's MM-DD. */
export function daysSinceAnniversary(anchor: string, refYmd: string): number {
  const refT = ymdToUTC(refYmd);
  const refYear = Number(refYmd.slice(0, 4));
  let prev = occurrenceUTC(anchor, refYear);
  if (prev > refT) prev = occurrenceUTC(anchor, refYear - 1);
  return Math.round((refT - prev) / 86_400_000);
}
/**
 * Is the anchor's anniversary within the window [-daysAfter, +daysBefore] of the
 * reference date? The owner's primary use is « X jours AVANT » (daysBefore); daysAfter
 * (default 0) optionally also matches the days just after.
 */
export function anniversaryWithin(
  anchor: string,
  refYmd: string,
  daysBefore: number,
  daysAfter = 0,
): boolean {
  if (daysUntilAnniversary(anchor, refYmd) <= Math.max(0, daysBefore)) return true;
  if (daysAfter > 0 && daysSinceAnniversary(anchor, refYmd) <= daysAfter) return true;
  return false;
}

// ─────────────────────────────────────────────────── legacy single-rule shim

/**
 * Map a legacy single-`rule` string (segment-rules.ts vocabulary) to a one-leaf tree,
 * so existing dynamic segments resolve through the NEW engine with no DB backfill. An
 * unrecognised legacy rule maps to a `never` leaf (matches nobody — the same fail-safe
 * the removed legacy single-rule matcher used).
 */
export function legacyRuleToTree(rule: string | null): RuleNode {
  if (!rule) return { kind: "never" };
  if (rule === "marketing_opted_in") return { kind: "marketing_opted_in" };
  if (rule === "has_orders") return { kind: "has_orders" };
  if (rule === "no_orders") return { kind: "no_orders" };
  if (rule === "birthday_month") return { kind: "birthday_month" };
  if (rule === "birthday_today") return { kind: "birthday_today" };
  return { kind: "never" };
}

/**
 * The (month, day) pairs of every calendar day in the window [ref-daysAfter,
 * ref+daysBefore], for the SET-BASED anniversary SQL `(extract(month …), extract(day
 * …)) IN (…)`. Equivalent to the per-profile `anniversaryWithin`: an anchor's MM-DD
 * lands in this list iff its nearest occurrence is inside the window. Applies the SAME
 * Feb-29 fold — when Feb-28 falls in the window in a common year, Feb-29 is added too so
 * a leap-day birthday/event still matches. De-duped.
 */
export function anniversaryMdPairsWindow(
  refYmd: string,
  daysBefore: number,
  daysAfter = 0,
): Array<[number, number]> {
  const DAY = 86_400_000;
  const start = ymdToUTC(refYmd) - Math.max(0, daysAfter) * DAY;
  const end = ymdToUTC(refYmd) + Math.max(0, daysBefore) * DAY;
  const seen = new Set<string>();
  const out: Array<[number, number]> = [];
  const add = (m: number, d: number) => {
    const k = `${m}-${d}`;
    if (!seen.has(k)) {
      seen.add(k);
      out.push([m, d]);
    }
  };
  for (let t = start; t <= end; t += DAY) {
    const dt = new Date(t);
    const m = dt.getUTCMonth() + 1;
    const d = dt.getUTCDate();
    add(m, d);
    // Feb-28 in a common year also targets Feb-29 anchors (mirrors occurrenceUTC's fold).
    if (m === 2 && d === 28 && !isLeapYear(dt.getUTCFullYear())) add(2, 29);
  }
  return out;
}
