/**
 * Tax (TVA) engine — the pure half: types, setting keys, the rate cascade,
 * the amount computation, and bps↔percent formatting. No DB, no React, no
 * "server-only" — safe to import from client components (admin forms need
 * `percentFromBps` / `TAX_SETTING_KEYS` / `TaxConfig`).
 *
 * The server half (`./index.ts`, which re-exports this file) adds
 * `getTaxConfig()` — the settings-backed config resolver. Server code keeps
 * importing everything from `@/lib/tax`; client code imports from here.
 *
 * Scale conventions (single source of truth for the whole tax subsystem):
 *   • Money is INTEGER millimes (minor units) via `@/lib/price` — same scale as
 *     every other monetary column (read `*_cents` as "integer minor units").
 *   • Rates are BASIS POINTS (bps): 1900 = 19 %, 700 = 7 %. Stored on
 *     `products.tax_rate_bps`, `categories.tax_rate_bps`, `tax_rules.rate_bps`.
 *
 * The cascade (MOST-SPECIFIC-WINS) for a line's effective rate:
 *   product override → tax_rules(attribute-value filter) → brand → category(→parent)
 *   → global default.
 */

// ─────────────────────────────────────────────────────────────── config

/**
 * `disabled` — no tax computed or shown anywhere (the inert default).
 * `ttc`      — prices are tax-INCLUSIVE; tax is an informational EXTRACT and
 *              does NOT change the total.
 * `ht`       — prices are tax-EXCLUSIVE; tax is ADDED on top of the total.
 */
export type TaxMode = "disabled" | "ttc" | "ht";

export type TaxConfig = {
  mode: TaxMode;
  /** Global fallback rate in basis points (1900 = 19 %). */
  defaultRateBps: number;
  /** Display label, e.g. "TVA". */
  label: string;
  /** Whether tax also applies to the shipping fee. */
  onShipping: boolean;
};

/** Settings keys this engine reads — single source for admin + resolver. */
export const TAX_SETTING_KEYS = {
  mode: "tax.mode",
  defaultRateBps: "tax.default_rate_bps",
  label: "tax.label",
  onShipping: "tax.on_shipping",
} as const;

// ───────────────────────────────────────────────── Tokyo Care service TVA

/**
 * TVA on the Tokyo Care protection add-on — a SEPARATE knob (Système → Taxes →
 * « Tokyo Care ») so the service can be taxed at its own rate, or exempted, independently
 * of the goods it rides on. It is gated by the GLOBAL tax mode like everything
 * else: `disabled` → no care tax; `ht` → added on top of the care charge; `ttc`
 * → informational extract baked into the care price. `taxable=false` zeroes it
 * even when the store otherwise charges TVA (a tax-exempt service).
 */
export type CareTaxConfig = {
  /** Whether the Tokyo Care charge is taxed at all. */
  taxable: boolean;
  /** Rate in basis points (1900 = 19 %); falls back to the global default when unset. */
  rateBps: number;
  /** Display label, e.g. "TVA". */
  label: string;
};

export const CARE_TAX_SETTING_KEYS = {
  taxable: "tax.care.taxable",
  rateBps: "tax.care.rate_bps",
  label: "tax.care.label",
} as const;

/**
 * TVA (integer millimes) on a Tokyo Care charge. Zero when the service is not
 * taxable or the store has tax disabled. Otherwise defers to {@link computeTaxCents}
 * with the care rate + the GLOBAL mode (so `ht` adds on top, `ttc` extracts).
 */
export function computeCareTaxCents(
  careCents: number,
  config: Pick<CareTaxConfig, "taxable" | "rateBps">,
  mode: TaxMode,
): number {
  if (!config.taxable) return 0;
  return computeTaxCents(careCents, config.rateBps, mode);
}

// ──────────────────────────────────────────────────────────── resolution

/** Which level of the cascade supplied the effective rate — for admin clarity. */
export type TaxRateSource = "product" | "rule" | "brand" | "category" | "global";

/**
 * Already-loaded inputs for the rate cascade. The caller batches the DB reads
 * (product override, matched attribute-value rule rate, the category chain's
 * resolved value) and passes plain numbers here — so resolving N order lines is
 * pure, allocation-free code. Mirrors the warranty resolver's input shape.
 */
export type TaxRateInput = {
  /** `products.tax_rate_bps` for the line's product, or null. */
  productTaxBps: number | null;
  /** MAX matching `tax_rules.rate_bps` across the product's attribute values, or null. */
  matchedRuleBps: number | null;
  /** `brands.tax_rate_bps` for the line's brand, or null. */
  brandTaxBps?: number | null;
  /**
   * Category-chain rate (child→parent), already collapsed to a single value via
   * `categoryChainTaxBps` — or the raw chain array; both are handled.
   */
  categoryChainTaxBps: (number | null)[] | number | null;
  /** Global fallback (`getTaxConfig().defaultRateBps`). */
  globalBps: number;
};

export type ResolvedTaxRate = {
  /** Effective rate in basis points. */
  bps: number;
  /** Which cascade level won. */
  source: TaxRateSource;
};

/**
 * Collapse a category chain (ordered child→parent) to its effective tax rate:
 * the FIRST non-null `tax_rate_bps` walking from the most-specific category up
 * to the root wins. Returns null when no category in the chain sets a rate — the
 * caller then falls through to the global default. Centralised so the storefront
 * mapper, the admin "inherited" hint, and the order snapshot all agree.
 */
export function categoryChainTaxBps(
  chain: (number | null | undefined)[] | null | undefined,
): number | null {
  if (!chain) return null;
  for (const v of chain) {
    if (v != null) return v;
  }
  return null;
}

/**
 * Resolve the effective tax rate (bps) for one line via the MOST-SPECIFIC-WINS
 * cascade:
 *
 *   product.tax_rate_bps
 *     ?? max(matched attribute-value tax_rules.rate_bps)
 *     ?? brand.tax_rate_bps
 *     ?? category chain (child→parent first non-null)
 *     ?? global defaultRateBps
 *
 * All inputs are pre-loaded so a caller batches the data once. `categoryChainTaxBps`
 * may be passed either as the already-collapsed number (or null) or as the raw
 * ordered chain array — both are handled. The BRAND tier sits between filter and
 * category (a brand-specific rate outranks a category rate).
 */
export function resolveTaxRateBps(input: TaxRateInput): ResolvedTaxRate {
  if (input.productTaxBps != null) {
    return { bps: input.productTaxBps, source: "product" };
  }
  if (input.matchedRuleBps != null) {
    return { bps: input.matchedRuleBps, source: "rule" };
  }
  if (input.brandTaxBps != null) {
    return { bps: input.brandTaxBps, source: "brand" };
  }
  const categoryBps = Array.isArray(input.categoryChainTaxBps)
    ? categoryChainTaxBps(input.categoryChainTaxBps)
    : input.categoryChainTaxBps;
  if (categoryBps != null) {
    return { bps: categoryBps, source: "category" };
  }
  return { bps: input.globalBps, source: "global" };
}

// ──────────────────────────────────────────────────────────── compute

/**
 * Compute the tax amount (integer millimes) for a taxable base.
 *
 *   • `disabled` → always 0.
 *   • `ttc` (inclusive) → EXTRACT the tax already baked into the price. Does
 *     NOT change the total — it's informational ("dont TVA X"). The base is
 *     gross, so tax = base − base/(1 + rate) = base − base·10000/(10000+rate).
 *   • `ht` (exclusive) → ADD tax on top of the net base: tax = base·rate/10000.
 *     This DOES increase the order total.
 *
 * Returns an integer (rounded) so it can be stored directly in `*_cents`
 * columns and summed without drift. A zero / negative base or rate yields 0.
 */
export function computeTaxCents(
  taxableCents: number,
  rateBps: number,
  mode: TaxMode,
): number {
  if (mode === "disabled") return 0;
  if (!Number.isFinite(taxableCents) || taxableCents <= 0) return 0;
  if (!Number.isFinite(rateBps) || rateBps <= 0) return 0;

  if (mode === "ttc") {
    // Inclusive: peel the tax out of a gross price. The net = gross · 10000/(10000+rate).
    const net = (taxableCents * 10000) / (10000 + rateBps);
    return Math.round(taxableCents - net);
  }
  // ht — exclusive: add tax on top of a net price.
  return Math.round((taxableCents * rateBps) / 10000);
}

// ──────────────────────────────────────────────────────── formatting

/** bps → display string, e.g. 1900 → "19 %". Trims trailing zeros (1950 → "19,5 %"). */
export function formatTaxRate(bps: number): string {
  const pct = percentFromBps(bps);
  const str = Number.isInteger(pct)
    ? String(pct)
    : pct.toLocaleString("fr-FR", { maximumFractionDigits: 2 });
  return `${str} %`;
}

/** Admin %→bps: 19 → 1900. Rounds to whole bps. */
export function bpsFromPercent(pct: number): number {
  const n = Number(pct);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

/** Admin bps→%: 1900 → 19. */
export function percentFromBps(bps: number): number {
  const n = Number(bps);
  return Number.isFinite(n) ? n / 100 : 0;
}
