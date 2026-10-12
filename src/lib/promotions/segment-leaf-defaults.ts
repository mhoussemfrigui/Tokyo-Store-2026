import type { RuleLeaf } from "./rule-tree";

/**
 * Default params for a freshly-added builder leaf — PURE + client-safe. Every offered
 * kind maps to params that pass its `LEAVES[kind].validate`, so a condition the admin
 * adds is valid the instant it appears (the save button gates on isValidRuleTree). A
 * parity test (segment-leaf-defaults.test.ts) asserts this for EVERY OFFERED_LEAF_KIND,
 * so a new leaf kind can't ship a default that the validator would reject.
 */
export function defaultLeaf(kind: string): RuleLeaf {
  switch (kind) {
    case "cart_total_gte":
    case "cart_total_lte":
      return { kind, cents: 0 };
    case "cart_age_gte_days":
    case "cart_age_lte_days":
    case "account_age_gte_days":
    case "account_age_lte_days":
      return { kind, days: 7 };
    case "cart_item_count":
      return { kind, op: "gte", count: 1, distinct: false };
    case "age_gte":
    case "age_lte":
      return { kind, years: 18 };
    case "gender":
      return { kind, value: "female" };
    case "birthday_anniversary":
      return { kind, daysBefore: 7, daysAfter: 0 };
    default:
      // has_orders / no_orders / cart_has_items / birthday_month / birthday_today /
      // marketing_opted_in — no params.
      return { kind };
  }
}
