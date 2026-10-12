/**
 * Price-validity window for a PDP Offer's JSON-LD — `validFrom` + `priceValidUntil`.
 *
 * PURE + unit-tested. Extracted from the inline PDP @graph so this date logic — the
 * one merchant-listing computation without test coverage — is pinned and can't drift.
 * See src/lib/db/tests/offer-validity.test.ts.
 *
 * • `priceValidUntil` — Google warns when an Offer omits it. Default to a rolling
 *   one-year horizon (the PDP is force-dynamic, so the value is recomputed every
 *   request and never actually goes stale). BUT when an active fixed-window promo
 *   discounts the price, cap at the EARLIER of the promo end and that horizon: past
 *   the sale the price rises again, so a year-out validity would advertise a lapsed
 *   sale price to Google Merchant long after it ended (a structured-price mismatch).
 *
 * • `validFrom` — the date the CURRENT price became valid, bracketing the window with
 *   `priceValidUntil`. On an active fixed-window promo the current (discounted) price
 *   started at the promo's `starts_at`; otherwise the offer has been valid since the
 *   product was created. Clamped to never exceed `now` (a missing/future promo start
 *   falls back to creation) so `validFrom ≤ today ≤ priceValidUntil` always holds.
 *
 * Both returned as `YYYY-MM-DD` (date-only), matching Google's examples.
 */
export function resolveOfferValidity(input: {
  /** Current wall-clock in ms (the caller passes `Date.now()`). */
  nowMs: number;
  /** Product creation time in ms — the lower bound for `validFrom`. */
  createdAtMs: number;
  /** Active fixed-window promo start in ms, or null when no such promo. */
  promoStartsAtMs: number | null;
  /** Active fixed-window promo end in ms, or null when no such promo / no end date. */
  promoEndsAtMs: number | null;
}): { validFrom: string; priceValidUntil: string } {
  const { nowMs, createdAtMs, promoStartsAtMs, promoEndsAtMs } = input;

  const oneYearOutMs = nowMs + 365 * 24 * 60 * 60 * 1000;
  const priceValidUntilMs =
    promoEndsAtMs != null && promoEndsAtMs < oneYearOutMs ? promoEndsAtMs : oneYearOutMs;

  // Only a promo start at/before now can move validFrom forward from creation — a
  // future or absent start leaves the offer valid since the product existed.
  const validFromMs =
    promoStartsAtMs != null && promoStartsAtMs <= nowMs ? promoStartsAtMs : createdAtMs;

  const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  return { validFrom: day(validFromMs), priceValidUntil: day(priceValidUntilMs) };
}
