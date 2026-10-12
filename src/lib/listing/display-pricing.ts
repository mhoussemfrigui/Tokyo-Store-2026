import { MONEY_MAX_DECIMALS } from "@/lib/price";

/**
 * Listing (card) price semantics — the ONE definition shared by the catalog
 * mapper (`lib/api/products.ts`), the /promotions + home promotions pools, the
 * product card and the listing filters, so a product can never qualify as « on
 * promotion » on one surface while showing no discount on another. Pure (no
 * React, no server-only): imported by server and client code alike.
 */

/** Price pair in integer minor units (millimes). `oldPriceCents` = compare-at. */
export type PricePair = { priceCents: number; oldPriceCents?: number | null };

/**
 * Integer minor units rounded to the storefront DISPLAY precision (`decimals`,
 * the admin `price.decimals` setting) — i.e. the amount `formatMoney` prints.
 * Same clamp as the formatter, same half-up rounding as `toLocaleString` for
 * the (non-negative) prices it is used on. Integer arithmetic on millimes, so
 * no float drift from the lossy major-unit `price`.
 */
export function toDisplayMinor(minor: number, decimals: number): number {
  const d = Math.max(0, Math.min(MONEY_MAX_DECIMALS, Math.trunc(Number(decimals)) || 0));
  const step = 10 ** (MONEY_MAX_DECIMALS - d);
  return Math.round((Number(minor) || 0) / step) * step;
}

/**
 * Whether the card shows a struck-through « was » price: the compare-at must be
 * STRICTLY above the price as DISPLAYED (a 180,200 vs 179,900 pair both read
 * « 180 TND » at whole-dinar precision — striking one would show « 180 → 180 »).
 * The same predicate drives the « En promotion uniquement » filter and its
 * facet availability.
 */
export function hasVisibleCompareAt(p: PricePair, decimals: number): boolean {
  return (
    p.oldPriceCents != null &&
    toDisplayMinor(p.oldPriceCents, decimals) > toDisplayMinor(p.priceCents, decimals)
  );
}

/**
 * A stored compare-at is only a real « was » price when it is strictly above the
 * price; anything else (a stale value left after a price increase, an input
 * mistake) is dropped to null so no surface renders a « was » price at or below
 * the current one.
 */
export function normalizeCompareAt(
  priceCents: number,
  oldPriceCents: number | null | undefined,
): number | null {
  return oldPriceCents != null && oldPriceCents > priceCents ? oldPriceCents : null;
}

/**
 * The variant a VARIABLE product's listing price comes from: the CHEAPEST one
 * (« à partir de »), availability ignored; on a price tie the FIRST in display
 * order wins. Null for an empty list.
 */
export function cheapestVariant<V extends { priceCents: number }>(variants: readonly V[]): V | null {
  if (variants.length === 0) return null;
  return variants.reduce((a, b) => (b.priceCents < a.priceCents ? b : a));
}

/**
 * The card's price + compare-at for a product row: the cheapest live variant's
 * pair for a variable product that has variants, else the row's own pair —
 * compare-at normalised ({@link normalizeCompareAt}). `variants` must be in
 * display order (the mapper's variant load order) and only passed for variable
 * products.
 */
export function listingDisplayPricing(
  row: { price_cents: number; old_price_cents: number | null },
  variants?: readonly PricePair[] | null,
): { priceCents: number; oldPriceCents: number | null } {
  const cheapest = cheapestVariant(variants ?? []);
  const priceCents = cheapest?.priceCents ?? row.price_cents;
  return {
    priceCents,
    oldPriceCents: normalizeCompareAt(
      priceCents,
      cheapest ? (cheapest.oldPriceCents ?? null) : row.old_price_cents,
    ),
  };
}

/**
 * Deal strength (0..1) as the CARD's « −X% » shows it, before rounding: the
 * effective price (after any live engine promotion) against the struck-through
 * reference — the compare-at when set, else the pre-promotion price when a
 * promotion lowered it (the exact rule `enrichWithLivePromos` applies to the
 * card). 0 when nothing is struck.
 */
export function cardDealFraction(
  display: { priceCents: number; oldPriceCents: number | null },
  effectivePriceCents: number = display.priceCents,
): number {
  const reference =
    display.oldPriceCents != null && display.oldPriceCents > display.priceCents
      ? display.oldPriceCents
      : effectivePriceCents < display.priceCents
        ? display.priceCents
        : null;
  if (reference == null || reference <= 0 || effectivePriceCents >= reference) return 0;
  return 1 - Math.max(0, effectivePriceCents) / reference;
}
