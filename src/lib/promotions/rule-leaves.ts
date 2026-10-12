/**
 * Leaf registry for the compound segment rule tree — PURE + client-safe. Every leaf
 * KIND is defined ONCE here with its param validator, French description, and the
 * in-memory `matches(leaf, facts)` predicate (the per-checkout evaluator). The
 * whole-audience SQL compiler (Phase 6d, rule-tree-sql.ts) keys its `toSql` off the
 * SAME kinds; a parity test keeps the two evaluators in lockstep.
 */
import { CUSTOMER_GENDERS } from "@/modules/customer/types";
import { isLeapYear } from "./segment-rules";
import {
  anniversaryWithin,
  isGroup,
  MAX_GROUP_CHILDREN,
  MAX_TREE_DEPTH,
  MAX_TREE_LEAVES,
  MIN_GROUP_CHILDREN,
  type RuleLeaf,
  type RuleNode,
} from "./rule-tree";

export type SegmentCartFacts = {
  /** SUM(unit_price_cents * quantity) of the buyer's live cart, millimes. */
  totalCents: number;
  /** Days since the cart's last activity (abandoned-cart age). */
  ageDays: number;
  /** SUM(quantity) — total units. */
  itemUnits: number;
  /** COUNT(*) of distinct cart lines. */
  itemLines: number;
};
/** Everything a leaf may inspect. The resolver builds it (lazily — see `needs`). */
export type SegmentFacts = {
  /** Live placed-order count (has_orders / no_orders — first-order semantics). */
  orderCount: number;
  marketingOptIn: boolean;
  birthday: string | null;
  ageYears: number | null;
  gender: string | null;
  accountAgeDays: number;
  cart: SegmentCartFacts | null;
  /** Store-TZ reference date, supplied by the resolver (keeps this pure). */
  ref: { ymd: string; year: number; month: number; day: number };
};

export type LeafNeed = "orders" | "cart";
export type LeafDef = {
  label: string;
  /** Optional one-line plain-French explanation shown under the label in the builder
   *  (and as the option subtitle in the condition picker), so a cryptic leaf is
   *  self-explanatory. Pure metadata — not used by matches/toSql, so the parity test
   *  is unaffected. */
  help?: string;
  family: "Commandes" | "Panier" | "Démographie" | "Événements de vie" | "Consentement";
  needs: readonly LeafNeed[];
  /** Params are well-formed for this kind. */
  validate: (leaf: RuleLeaf) => boolean;
  describe: (leaf: RuleLeaf) => string;
  matches: (leaf: RuleLeaf, f: SegmentFacts) => boolean;
};

// param helpers
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const nnInt = (v: unknown): number | null => {
  const n = num(v);
  return n != null && n >= 0 ? Math.trunc(n) : null;
};
const dt = (cents: number) => (cents / 1000).toLocaleString("fr-FR");

export const LEAVES: Record<string, LeafDef> = {
  // ── Commandes
  has_orders: {
    label: "A déjà commandé",
    family: "Commandes",
    needs: ["orders"],
    validate: () => true,
    describe: () => "A déjà commandé",
    matches: (_l, f) => f.orderCount > 0,
  },
  no_orders: {
    label: "N'a jamais commandé",
    family: "Commandes",
    needs: ["orders"],
    validate: () => true,
    describe: () => "N'a jamais commandé (nouveau client)",
    matches: (_l, f) => f.orderCount === 0,
  },

  // ── Panier
  cart_has_items: {
    label: "A un panier non vide",
    family: "Panier",
    needs: ["cart"],
    validate: () => true,
    describe: () => "A un panier en cours (non vide)",
    matches: (_l, f) => !!f.cart && f.cart.itemUnits > 0,
  },
  cart_total_gte: {
    label: "Total du panier ≥",
    family: "Panier",
    needs: ["cart"],
    validate: (l) => nnInt(l.cents) != null,
    describe: (l) => `Total du panier ≥ ${dt(Number(l.cents))} DT`,
    matches: (l, f) => !!f.cart && f.cart.totalCents >= Number(l.cents),
  },
  cart_total_lte: {
    label: "Total du panier ≤",
    family: "Panier",
    needs: ["cart"],
    validate: (l) => nnInt(l.cents) != null,
    describe: (l) => `Total du panier ≤ ${dt(Number(l.cents))} DT`,
    matches: (l, f) => !!f.cart && f.cart.totalCents <= Number(l.cents),
  },
  cart_age_gte_days: {
    label: "Panier abandonné depuis ≥ (jours)",
    family: "Panier",
    needs: ["cart"],
    validate: (l) => nnInt(l.days) != null,
    describe: (l) => `Panier inactif depuis ≥ ${Number(l.days)} j`,
    matches: (l, f) => !!f.cart && f.cart.ageDays >= Number(l.days),
  },
  cart_age_lte_days: {
    label: "Panier actif depuis ≤ (jours)",
    family: "Panier",
    needs: ["cart"],
    validate: (l) => nnInt(l.days) != null,
    describe: (l) => `Panier actif depuis ≤ ${Number(l.days)} j`,
    matches: (l, f) => !!f.cart && f.cart.ageDays <= Number(l.days),
  },
  cart_item_count: {
    label: "Nombre d'articles au panier",
    family: "Panier",
    needs: ["cart"],
    validate: (l) => nnInt(l.count) != null && (l.op === "eq" || l.op === "gte" || l.op === "lte"),
    describe: (l) => {
      const what = l.distinct ? "lignes" : "articles";
      const sign = l.op === "gte" ? "≥" : l.op === "lte" ? "≤" : "=";
      return `Panier : ${what} ${sign} ${Number(l.count)}`;
    },
    matches: (l, f) => {
      if (!f.cart) return false;
      const n = l.distinct ? f.cart.itemLines : f.cart.itemUnits;
      const c = Number(l.count);
      return l.op === "gte" ? n >= c : l.op === "lte" ? n <= c : n === c;
    },
  },

  // ── Démographie
  age_gte: {
    label: "Âge ≥ (ans)",
    family: "Démographie",
    needs: [],
    validate: (l) => nnInt(l.years) != null,
    describe: (l) => `Âge ≥ ${Number(l.years)} ans`,
    matches: (l, f) => f.ageYears != null && f.ageYears >= Number(l.years),
  },
  age_lte: {
    label: "Âge ≤ (ans)",
    family: "Démographie",
    needs: [],
    validate: (l) => nnInt(l.years) != null,
    describe: (l) => `Âge ≤ ${Number(l.years)} ans`,
    matches: (l, f) => f.ageYears != null && f.ageYears <= Number(l.years),
  },
  gender: {
    label: "Genre",
    family: "Démographie",
    needs: [],
    validate: (l) => (CUSTOMER_GENDERS as readonly string[]).includes(String(l.value)),
    describe: (l) =>
      `Genre : ${l.value === "female" ? "Femme" : l.value === "male" ? "Homme" : "Autre"}`,
    matches: (l, f) => f.gender === l.value,
  },
  account_age_gte_days: {
    label: "Ancienneté du compte ≥ (jours)",
    family: "Démographie",
    needs: [],
    validate: (l) => nnInt(l.days) != null,
    describe: (l) => `Compte créé depuis ≥ ${Number(l.days)} j`,
    matches: (l, f) => f.accountAgeDays >= Number(l.days),
  },
  account_age_lte_days: {
    label: "Ancienneté du compte ≤ (jours)",
    family: "Démographie",
    needs: [],
    validate: (l) => nnInt(l.days) != null,
    describe: (l) => `Compte créé depuis ≤ ${Number(l.days)} j`,
    matches: (l, f) => f.accountAgeDays <= Number(l.days),
  },

  // ── Événements de vie
  birthday_anniversary: {
    label: "Anniversaire (X jours avant)",
    family: "Événements de vie",
    needs: [],
    validate: (l) => nnInt(l.daysBefore) != null,
    describe: (l) => `Anniversaire — ${Number(l.daysBefore)} j avant`,
    matches: (l, f) =>
      f.birthday != null &&
      anniversaryWithin(f.birthday, f.ref.ymd, Number(l.daysBefore), nnInt(l.daysAfter) ?? 0),
  },
  birthday_month: {
    label: "Anniversaire ce mois-ci",
    family: "Événements de vie",
    needs: [],
    validate: () => true,
    describe: () => "Anniversaire ce mois-ci",
    matches: (_l, f) => f.birthday != null && Number(f.birthday.slice(5, 7)) === f.ref.month,
  },
  birthday_today: {
    label: "Anniversaire aujourd'hui",
    family: "Événements de vie",
    needs: [],
    validate: () => true,
    describe: () => "Anniversaire aujourd'hui",
    matches: (_l, f) => {
      if (!f.birthday) return false;
      const bM = Number(f.birthday.slice(5, 7));
      const bD = Number(f.birthday.slice(8, 10));
      if (bM === 2 && bD === 29 && !isLeapYear(f.ref.year)) return f.ref.month === 2 && f.ref.day === 28;
      return bM === f.ref.month && bD === f.ref.day;
    },
  },

  // ── Consentement
  marketing_opted_in: {
    label: "Accepte les emails marketing",
    help: "Le client a coché « recevoir les offres » sur son compte (opt-in marketing).",
    family: "Consentement",
    needs: [],
    validate: () => true,
    describe: () => "Accepte les emails marketing",
    matches: (_l, f) => f.marketingOptIn,
  },

  // ── internal — the legacy shim's fail-safe (never offered in the builder)
  never: {
    label: "(aucun)",
    family: "Consentement",
    needs: [],
    validate: () => true,
    describe: () => "(règle inconnue — ne cible personne)",
    matches: () => false,
  },
};

/** Leaf kinds the admin builder offers (everything except the internal `never`). */
export const OFFERED_LEAF_KINDS = Object.keys(LEAVES).filter((k) => k !== "never");

// ─────────────────────────────────────────────────── validation + evaluation

/**
 * Fail-closed structural + leaf validation. Rejects: unknown leaf kinds, bad params,
 * an EMPTY group (would match everybody), a group over MAX_GROUP_CHILDREN, a tree
 * deeper than MAX_TREE_DEPTH or with more than MAX_TREE_LEAVES leaves. The server MUST
 * run this before persisting a client-supplied tree.
 */
export function isValidRuleTree(node: RuleNode): boolean {
  const state = { leaves: 0 };
  const walk = (n: RuleNode, depth: number): boolean => {
    if (depth > MAX_TREE_DEPTH) return false;
    if (isGroup(n)) {
      const c = n.children;
      if (!Array.isArray(c) || c.length < MIN_GROUP_CHILDREN || c.length > MAX_GROUP_CHILDREN) return false;
      return c.every((child) => walk(child, depth + 1));
    }
    if (typeof n?.kind !== "string") return false;
    const def = LEAVES[n.kind];
    if (!def) return false;
    if (++state.leaves > MAX_TREE_LEAVES) return false;
    return def.validate(n);
  };
  return walk(node, 1);
}

/** Evaluate the tree against a buyer's facts (the per-checkout predicate). */
export function ruleTreeMatches(node: RuleNode, facts: SegmentFacts): boolean {
  const val = (n: RuleNode): boolean => {
    if (isGroup(n)) {
      const r = n.op === "and" ? n.children.every(val) : n.children.some(val);
      return n.negate ? !r : r;
    }
    const r = LEAVES[n.kind]?.matches(n, facts) ?? false;
    return n.negate ? !r : r;
  };
  return val(node);
}

/** The union of fact-groups any leaf in the tree needs — drives lazy fact loading. */
export function ruleTreeNeeds(node: RuleNode): Set<LeafNeed> {
  const out = new Set<LeafNeed>();
  const walk = (n: RuleNode) => {
    if (isGroup(n)) n.children.forEach(walk);
    else for (const need of LEAVES[n.kind]?.needs ?? []) out.add(need);
  };
  walk(node);
  return out;
}

/** French description of a tree (admin display). */
export function describeTree(node: RuleNode): string {
  const desc = (n: RuleNode): string => {
    if (isGroup(n)) {
      const joined = n.children.map(desc).join(n.op === "and" ? " ET " : " OU ");
      const body = n.children.length > 1 ? `(${joined})` : joined;
      return n.negate ? `NON ${body}` : body;
    }
    const d = LEAVES[n.kind]?.describe(n) ?? n.kind;
    return n.negate ? `NON (${d})` : d;
  };
  return desc(node);
}
