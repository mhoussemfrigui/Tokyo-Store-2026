/**
 * Customer-segment LEGACY dynamic-rule vocabulary — PURE, client-safe (no DB, no
 * "server-only"). A segment's single `rule` string is no longer evaluated or labelled
 * here: both resolvers map it through `legacyRuleToTree` (rule-tree.ts) onto the
 * compound rule-tree leaf registry, and the admin builder renders it via
 * `describeTree(legacyRuleToTree(rule))`. This module now owns only the write-time
 * validation of a legacy `rule` string (isValidDynamicRule) and the shared Gregorian
 * leap-year helper the anniversary math relies on.
 */

/** Gregorian leap-year test (÷4, except centuries not ÷400). */
export function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

/**
 * Is `rule` a recognized legacy dynamic-segment rule? Server actions MUST validate
 * with this before persisting a legacy single-rule segment — an unknown rule (typo /
 * crafted request) maps to a `never` leaf (legacyRuleToTree) that silently matches
 * NOBODY, making any promo targeting it inert with no error.
 */
export function isValidDynamicRule(rule: string): boolean {
  if (
    rule === "marketing_opted_in" ||
    rule === "has_orders" ||
    rule === "no_orders" ||
    rule === "birthday_today" ||
    rule === "birthday_month"
  ) {
    return true;
  }
  return false;
}
