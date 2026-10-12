import "server-only";

/**
 * Compound segment rule-tree — PURE unit tests (no DB). Covers the anniversary date
 * math, the legacy → tree shim, the fail-closed validator, and every leaf's matcher.
 * Run:
 *   tsx --conditions=react-server src/lib/db/tests/segment-rule-tree.test.ts
 */
import {
  daysUntilAnniversary,
  daysSinceAnniversary,
  anniversaryWithin,
  anniversaryOccurrenceYear,
  legacyRuleToTree,
  type RuleNode,
} from "@/lib/promotions/rule-tree";
import {
  isValidRuleTree,
  ruleTreeMatches,
  ruleTreeNeeds,
  describeTree,
  type SegmentFacts,
} from "@/lib/promotions/rule-leaves";

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.error(`  ✗ ${label}`); }
}

const F: SegmentFacts = {
  orderCount: 5,
  marketingOptIn: true,
  birthday: "1990-06-15",
  ageYears: 35,
  gender: "female",
  accountAgeDays: 400,
  cart: { totalCents: 300_000, ageDays: 10, itemUnits: 4, itemLines: 2 },
  ref: { ymd: "2026-06-15", year: 2026, month: 6, day: 15 },
};
const m = (node: RuleNode, facts: SegmentFacts = F) => ruleTreeMatches(node, facts);

// ── anniversary date math
check("daysUntilAnniversary: 5 days ahead", daysUntilAnniversary("2015-06-20", "2026-06-15") === 5);
check("daysUntilAnniversary: today = 0", daysUntilAnniversary("2026-06-15", "2026-06-15") === 0);
check("daysUntilAnniversary: wraps to next year", daysUntilAnniversary("2026-06-10", "2026-06-15") === 360);
check("Feb-29 folds to Feb-28 in a common year", daysUntilAnniversary("2020-02-29", "2026-02-28") === 0);
check("daysSinceAnniversary: 5 days ago", daysSinceAnniversary("2015-06-20", "2026-06-25") === 5);
// anniversaryOccurrenceYear — the recurring-send dedup key (stable across Dec→Jan).
check("occYear: mid-year anniversary → current year", anniversaryOccurrenceYear("2015-06-20", "2026-06-15") === 2026);
check("occYear: already passed this year → next year", anniversaryOccurrenceYear("2015-06-10", "2026-06-15") === 2027);
check("occYear: Jan anniversary reached in late Dec → next Jan's year", anniversaryOccurrenceYear("2015-01-05", "2026-12-30") === 2027);
check("occYear: same Jan anniversary reached in early Jan → SAME year (no double-send)", anniversaryOccurrenceYear("2015-01-05", "2027-01-02") === 2027);

check("anniversaryWithin before-window", anniversaryWithin("2015-06-20", "2026-06-15", 10) === true);
check("anniversaryWithin outside before-window", anniversaryWithin("2015-06-20", "2026-06-15", 3) === false);
check("anniversaryWithin after-window", anniversaryWithin("2015-06-20", "2026-06-25", 0, 10) === true);

// ── legacy shim
check("legacy marketing → leaf", JSON.stringify(legacyRuleToTree("marketing_opted_in")) === '{"kind":"marketing_opted_in"}');
check("legacy has_orders → leaf", JSON.stringify(legacyRuleToTree("has_orders")) === '{"kind":"has_orders"}');
check("legacy unknown → never", JSON.stringify(legacyRuleToTree("bogus")) === '{"kind":"never"}');
check("legacy null → never", JSON.stringify(legacyRuleToTree(null)) === '{"kind":"never"}');
check("legacy tree evaluates (has_orders, 5 placed)", m(legacyRuleToTree("has_orders")) === true);
check("never matches nobody", m({ kind: "never" }) === false);

// ── validator (fail-closed)
check("valid compound tree", isValidRuleTree({ op: "and", children: [{ kind: "cart_total_gte", cents: 1000 }, { kind: "gender", value: "female" }] }) === true);
check("empty group rejected", isValidRuleTree({ op: "and", children: [] }) === false);
check("unknown kind rejected", isValidRuleTree({ kind: "bogus" }) === false);
check("bad params rejected", isValidRuleTree({ kind: "cart_total_gte", cents: "x" }) === false);
check("invalid gender value rejected", isValidRuleTree({ kind: "gender", value: "??" }) === false);
check("over-13-children rejected", isValidRuleTree({ op: "or", children: Array.from({ length: 13 }, () => ({ kind: "has_orders" })) }) === false);
check("over-depth rejected", isValidRuleTree({ op: "and", children: [{ op: "and", children: [{ op: "and", children: [{ op: "and", children: [{ kind: "has_orders" }] }] }] }] }) === false);
check("over-24-leaves rejected", isValidRuleTree({ op: "or", children: [{ op: "or", children: Array.from({ length: 13 }, () => ({ kind: "has_orders" as const })) }, { op: "or", children: Array.from({ length: 12 }, () => ({ kind: "has_orders" as const })) }] }) === false);

// ── leaf matchers
check("has_orders", m({ kind: "has_orders" }) === true);
check("no_orders → false", m({ kind: "no_orders" }) === false);
check("cart_has_items", m({ kind: "cart_has_items" }) === true);
check("cart_has_items with no cart → false", m({ kind: "cart_has_items" }, { ...F, cart: null }) === false);
check("cart_total_gte 250k", m({ kind: "cart_total_gte", cents: 250_000 }) === true);
check("cart_total_gte 400k → false", m({ kind: "cart_total_gte", cents: 400_000 }) === false);
check("cart_age_gte_days 7 (abandoned)", m({ kind: "cart_age_gte_days", days: 7 }) === true);
check("cart_age_gte_days 15 → false", m({ kind: "cart_age_gte_days", days: 15 }) === false);
check("cart_item_count gte 4 (units)", m({ kind: "cart_item_count", op: "gte", count: 4 }) === true);
check("cart_item_count eq 2 distinct lines", m({ kind: "cart_item_count", op: "eq", count: 2, distinct: true }) === true);
check("age_gte 30", m({ kind: "age_gte", years: 30 }) === true);
check("age_lte 30 → false", m({ kind: "age_lte", years: 30 }) === false);
check("gender female", m({ kind: "gender", value: "female" }) === true);
check("gender male → false", m({ kind: "gender", value: "male" }) === false);
check("account_age_gte_days 365", m({ kind: "account_age_gte_days", days: 365 }) === true);
check("birthday_anniversary today", m({ kind: "birthday_anniversary", daysBefore: 5 }) === true);
check("birthday_month", m({ kind: "birthday_month" }) === true);
check("birthday_today", m({ kind: "birthday_today" }) === true);
check("marketing_opted_in", m({ kind: "marketing_opted_in" }) === true);

// ── compound + negation
check("AND both true", m({ op: "and", children: [{ kind: "cart_total_gte", cents: 250_000 }, { kind: "gender", value: "female" }] }) === true);
check("AND one false", m({ op: "and", children: [{ kind: "cart_total_gte", cents: 250_000 }, { kind: "gender", value: "male" }] }) === false);
check("OR one true", m({ op: "or", children: [{ kind: "gender", value: "male" }, { kind: "has_orders" }] }) === true);
check("group negate (NOT)", m({ op: "and", children: [{ kind: "gender", value: "male" }], negate: true }) === true);
check("leaf negate", m({ kind: "gender", value: "male", negate: true }) === true);
check("nested (A OR B) AND C", m({ op: "and", children: [{ op: "or", children: [{ kind: "gender", value: "male" }, { kind: "has_orders" }] }, { kind: "cart_total_gte", cents: 250_000 }] }) === true);

// ── needs + describe
const needs = ruleTreeNeeds({ op: "and", children: [{ kind: "cart_has_items" }, { kind: "has_orders" }, { kind: "gender", value: "female" }] });
check("ruleTreeNeeds collects cart + orders (gender needs nothing)", needs.has("cart") && needs.has("orders") && needs.size === 2);
check("describeTree renders French", describeTree({ op: "or", children: [{ kind: "gender", value: "female" }, { kind: "has_orders" }] }) === "(Genre : Femme OU A déjà commandé)");

console.log(`\n=== segment-rule-tree: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
