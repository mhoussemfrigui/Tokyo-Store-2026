/**
 * Money helpers, aligned with the main Tokyo Store platform.
 *
 * The backend stores money as INTEGER MINOR UNITS (millimes; 1 TND = 1000).
 * The current static catalog uses major-unit numbers (e.g. 249 = 249 TND), so
 * these helpers are mainly for the future backend swap (the HTTP source maps
 * `priceCents` → major units via `minorToDinars`). Keeping the same helper names
 * as the platform makes that swap mechanical.
 */
export const MINOR_PER_DINAR = 1000;

/** Convert integer millimes → major-unit dinars (e.g. 249000 → 249). */
export function minorToDinars(minor: number): number {
  return minor / MINOR_PER_DINAR;
}

/** Convert major-unit dinars → integer millimes (e.g. 249 → 249000). */
export function dinarsToMinor(dinars: number): number {
  return Math.round(dinars * MINOR_PER_DINAR);
}

/**
 * Format a major-unit amount for display, Tunisian French style.
 * Mirrors the storefront's existing `fmtPrice` (fr-TN grouping).
 */
export function formatDinars(amount: number, currency = "TND"): string {
  return `${amount.toLocaleString("fr-TN")} ${currency}`;
}
