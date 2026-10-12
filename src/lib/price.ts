/**
 * Money — the single source of truth for monetary scale + formatting.
 *
 * Every monetary amount in the app is stored as an INTEGER number of the
 * Tunisian Dinar's minor unit. `MINOR_PER_DINAR` is the ONE place that scale
 * is defined: all display formatting and all dinar↔minor parsing route through
 * it, so the scale can never drift between surfaces (cart, checkout, invoices,
 * admin, emails, analytics).
 *
 * TND subdivides into 1000 millimes — that is the real minor unit and what we
 * store. (Historically the app stored 1/100 and the DB columns are still named
 * `*_cents`; a one-time migration multiplied every stored value ×10. Read the
 * column name as "integer minor units", NOT literally centimes.)
 *
 * Display precision is admin-controllable: `formatMoney`/`formatCents` take an
 * optional `decimals` count, resolved server-side from the `price.decimals`
 * setting via `getPriceDecimals()` (see ./price-format). Default is whole
 * dinars so a fresh store reads cleanly.
 */

/** Minor units per dinar. TND = 1000 millimes. */
export const MINOR_PER_DINAR = 1000;

/**
 * Max fractional digits the minor unit can represent (3 for millimes, 2 for
 * centimes). Derived from the scale so it always tracks `MINOR_PER_DINAR`.
 */
export const MONEY_MAX_DECIMALS = Math.round(Math.log10(MINOR_PER_DINAR));

/**
 * Default fractional digits shown on the storefront. 0 ⇒ whole dinars. The
 * admin can override per-store via the `price.decimals` setting; server
 * surfaces resolve it and pass it to `formatMoney`.
 */
export const DEFAULT_PRICE_DECIMALS = 0;

/** Integer minor units → dinars (major, possibly fractional). */
export function minorToDinars(minor: number): number {
  return (minor || 0) / MINOR_PER_DINAR;
}

/** Dinars (major, possibly fractional) → integer minor units. */
export function dinarsToMinor(dinars: number): number {
  return Math.round((Number(dinars) || 0) * MINOR_PER_DINAR);
}

/**
 * MACHINE money format: integer minor units → a plain `.`-decimal major-unit
 * string (no grouping, no currency) for feeds / JSON-LD / CSV, where a
 * locale-formatted value ("7,50 TND") would break the consumer. NEVER rounds
 * below the minor-unit precision (millimes ⇒ 3dp), so it can't disagree with the
 * Google Merchant product feed — a "7.5" vs "7.500" gap trips Merchant's
 * price-mismatch disapproval when it cross-checks the landing page's structured
 * data. A larger display `decimals` (up to 4) is honoured. Single SSOT: the feed
 * builders and the JSON-LD Offer (price + shipping) route through this.
 */
export function formatMoneyMachine(minor: number, decimals: number = MONEY_MAX_DECIMALS): string {
  const d = Math.max(MONEY_MAX_DECIMALS, Math.min(4, Math.trunc(Number(decimals) || 0)));
  return minorToDinars(minor).toFixed(d);
}

/**
 * Core formatter: integer minor units → "X TND" (fr-FR grouped). `decimals`
 * is a FIXED fractional-digit count; clamped to what the minor unit supports.
 * Defaults to whole dinars — pass the admin `price.decimals` setting to show
 * millimes.
 *
 * `currency` + `position` LABEL the amount with the store's active currency
 * (Commandes → Devises): they default to "TND"/after so every existing caller
 * stays byte-identical; the storefront MoneyProvider passes the active currency's
 * symbol + position. NOTE: this RELABELS only — the millime scale is unchanged.
 */
export function formatMoney(
  minor: number,
  decimals: number = DEFAULT_PRICE_DECIMALS,
  currency: string = "TND",
  position: "before" | "after" = "after",
): string {
  const d = Math.max(0, Math.min(MONEY_MAX_DECIMALS, Math.trunc(decimals)));
  const num = minorToDinars(minor).toLocaleString("fr-FR", {
    minimumFractionDigits: d,
    maximumFractionDigits: d,
  });
  return position === "before" ? `${currency} ${num}` : `${num} ${currency}`;
}

/**
 * Whole-TND display from minor units ("X TND", rounded to the dinar). The
 * single formatter for cart / checkout / admin-list display, replacing the
 * `${Math.round(cents/100).toLocaleString("fr-FR")} TND` snippet that was
 * copy-pasted as a local `TND`/`fmt`/`formatTnd` const across ~15 files — so
 * the rounding policy can't drift between surfaces. Pass `decimals` to honor
 * the admin precision setting; omit it for the whole-dinar default. Use
 * `formatMoneyExact` for invoices/receipts that always need full precision.
 */
export function formatCents(minor: number, decimals?: number): string {
  return formatMoney(minor, decimals ?? DEFAULT_PRICE_DECIMALS);
}

/**
 * Exact money formatter for FINANCIAL DOCUMENTS — invoices, receipts, the
 * order-detail/confirmation totals. Unlike `formatCents` (whole-TND storefront
 * display) this always preserves sub-dinar precision so a discounted total
 * never misprints on a document the customer or accountant keeps. Shows
 * decimals only when the amount is fractional, so whole amounts still read
 * cleanly ("250 TND", not "250,000 TND").
 *
 * `currency` + `position` LABEL the amount with the store's active currency
 * (Commandes → Devises); they default to "TND"/after so every existing caller
 * stays byte-identical. The checkout summary + cart + order confirmation pass
 * the active currency so their totals carry the SAME label as the (currency-aware)
 * cart line items — relabel only, the millime scale + precision are unchanged.
 */
export function formatMoneyExact(
  minor: number,
  currency: string = "TND",
  position: "before" | "after" = "after",
): string {
  const value = minorToDinars(minor);
  const fractional = !Number.isInteger(value);
  const num = value.toLocaleString("fr-FR", {
    minimumFractionDigits: fractional ? MONEY_MAX_DECIMALS : 0,
    maximumFractionDigits: MONEY_MAX_DECIMALS,
  });
  return position === "before" ? `${currency} ${num}` : `${num} ${currency}`;
}

/** The app's OWN currency. Amounts in this code are stored as millimes. */
export const APP_CURRENCY = "TND";

/**
 * Integer minor units → "X <currency>" (fr-FR grouped, fixed `decimals`) for
 * the DYNAMIC-CURRENCY surfaces that cannot hardcode "TND" — e.g. the stock
 * panel / account orders rendering a per-record currency code. Same scale +
 * locale as `formatMoney`; the currency token is appended verbatim.
 *
 * `decimals` is a FIXED fractional-digit count. When omitted it is resolved
 * PER CURRENCY: the app's own currency (TND) defaults to full millime
 * precision (`MONEY_MAX_DECIMALS`, 3) so the third millime digit is never
 * truncated, while any FOREIGN currency keeps the historical 2dp default
 * (a foreign currency may use a different minor scale than the dinar). Pass an
 * explicit `decimals` to override either way; it is NOT clamped, since foreign
 * scales aren't bounded by `MONEY_MAX_DECIMALS`.
 */
export function formatMoneyWithCurrency(
  minor: number,
  currency: string,
  decimals?: number,
): string {
  const d =
    decimals ??
    (currency === APP_CURRENCY ? MONEY_MAX_DECIMALS : 2);
  return `${minorToDinars(minor).toLocaleString("fr-FR", {
    minimumFractionDigits: d,
    maximumFractionDigits: d,
  })} ${currency}`;
}
