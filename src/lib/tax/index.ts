import "server-only";

import { cache } from "react";

import { getSettingsMap } from "@/modules/cms/setting/queries";

import {
  TAX_SETTING_KEYS,
  CARE_TAX_SETTING_KEYS,
  type TaxConfig,
  type TaxMode,
  type CareTaxConfig,
} from "./shared";

/**
 * Tax (TVA) engine — server entry point.
 *
 * The pure half (types, setting keys, rate cascade, amount computation,
 * bps↔percent formatting) lives in `./shared` so client components can import
 * it without dragging in "server-only". This file re-exports all of it and adds
 * the server-bound piece: the config resolvers reading site settings from the
 * DB — `getTaxConfig()` (soft, display) and `getTaxConfigStrict()` (writes).
 * Server code imports everything from `@/lib/tax`; client code imports from
 * `@/lib/tax/shared`.
 */

export * from "./shared";

const DEFAULT_MODE: TaxMode = "disabled";
const DEFAULT_RATE_BPS = 1900;
const DEFAULT_LABEL = "TVA";
const DEFAULT_ON_SHIPPING = false;

function parseMode(v: string | null | undefined): TaxMode {
  return v === "ttc" || v === "ht" || v === "disabled" ? v : DEFAULT_MODE;
}

function parseBps(v: string | null | undefined, fallback: number): number {
  if (v == null || v.trim() === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : fallback;
}

function parseBool(v: string | null | undefined, fallback: boolean): boolean {
  if (v == null || v === "") return fallback;
  return v === "true";
}

/**
 * Parse the tax config through a settings reader. A READ error PROPAGATES (it is
 * never turned into "disabled") — the strict half of the pair below, exported
 * so that contract is unit-testable without a DB.
 */
export async function readTaxConfig(
  readSettings: () => Promise<Record<string, string | null>>,
): Promise<TaxConfig> {
  const s = await readSettings();
  return {
    mode: parseMode(s[TAX_SETTING_KEYS.mode]),
    defaultRateBps: parseBps(s[TAX_SETTING_KEYS.defaultRateBps], DEFAULT_RATE_BPS),
    label: s[TAX_SETTING_KEYS.label]?.trim() || DEFAULT_LABEL,
    onShipping: parseBool(s[TAX_SETTING_KEYS.onShipping], DEFAULT_ON_SHIPPING),
  };
}

/**
 * STRICT resolver for every path that WRITES from the config: place-order and
 * edit-items (TVA snapshotted onto order lines + totals), set-invoice-tax and
 * the admin tax form (its prefill is what a save persists). A failed settings
 * read throws → the caller fails retryably instead of committing an order with
 * TVA silently off (tax_cents 0 on a TVA store, an HT total missing its TVA) or
 * saving "disabled" over the live mode. React-cached like the soft variant.
 */
export const getTaxConfigStrict = cache(
  (): Promise<TaxConfig> => readTaxConfig(getSettingsMap),
);

/**
 * Resolve the global tax config from site settings — the SOFT variant, for
 * DISPLAY surfaces only (storefront previews, order pages, documents).
 * React-cached so the whole thing is deduped per request (it shares
 * `getSettingsMap`'s single read). Tolerant of a cold DB / missing
 * `site_settings` table — returns the disabled default so the storefront never
 * errors before the admin enables tax. Never use it to compute money that gets
 * persisted: that is {@link getTaxConfigStrict}.
 */
export const getTaxConfig = cache(async (): Promise<TaxConfig> => {
  try {
    return await getTaxConfigStrict();
  } catch {
    // Settings table unavailable on a cold DB — tax stays fully disabled.
    return {
      mode: DEFAULT_MODE,
      defaultRateBps: DEFAULT_RATE_BPS,
      label: DEFAULT_LABEL,
      onShipping: DEFAULT_ON_SHIPPING,
    };
  }
});

// ───────────────────────────────────────────────── Tokyo Care service TVA

/** Care TVA defaults: taxable (a service is normally taxable), rate falls back to
 *  the global default (1900), label "TVA". The GLOBAL mode still gates it, so with
 *  tax disabled these have no effect. */
const CARE_TAX_DEFAULTS: CareTaxConfig = {
  taxable: true,
  rateBps: DEFAULT_RATE_BPS,
  label: DEFAULT_LABEL,
};

/** Parse the Tokyo Care TVA config through a settings reader (read error
 *  PROPAGATES in the strict variant). Unit-testable without a DB. */
export async function readCareTaxConfig(
  readSettings: () => Promise<Record<string, string | null>>,
): Promise<CareTaxConfig> {
  const s = await readSettings();
  return {
    taxable: parseBool(s[CARE_TAX_SETTING_KEYS.taxable], CARE_TAX_DEFAULTS.taxable),
    rateBps: parseBps(s[CARE_TAX_SETTING_KEYS.rateBps], CARE_TAX_DEFAULTS.rateBps),
    label: s[CARE_TAX_SETTING_KEYS.label]?.trim() || CARE_TAX_DEFAULTS.label,
  };
}

/** STRICT resolver — the order-placing paths that PERSIST the computed care TVA
 *  (place-order, place-quick-order, edit-items) + the admin form prefill. A failed
 *  read throws so the caller fails retryably instead of silently dropping the tax. */
export const getCareTaxConfigStrict = cache(
  (): Promise<CareTaxConfig> => readCareTaxConfig(getSettingsMap),
);

/** SOFT resolver — DISPLAY surfaces (storefront care offer, checkout preview).
 *  Degrades to the taxable 19 % default on a cold DB. */
export const getCareTaxConfig = cache(async (): Promise<CareTaxConfig> => {
  try {
    return await getCareTaxConfigStrict();
  } catch {
    return CARE_TAX_DEFAULTS;
  }
});
