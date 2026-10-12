import "server-only";

import { cookies } from "next/headers";

import { promotionService, type ProductDiscount } from "@/modules/promotion";
import { evaluateCouponEligibility } from "@/lib/promotions/coupon-eligibility";
import { resolveBuyerContext } from "@/lib/promotions/buyer-context";
import type { CouponCartLine } from "@/lib/promotions/scoped-coupon";
import { isUuid } from "@/lib/utils/uuid";

/**
 * Cart-side coupon resolver. Reads the `gz.coupon` (manual code) and
 * `gz.promo` (URL-trigger) cookies set by the promotion actions, re-checks
 * the promotion is still live + qualifies for the current cart subtotal,
 * and returns the discount info the cart / checkout pages should display —
 * and the promotion the place-order actions forward (callers pass the LIVE
 * re-priced subtotal + lines, `@/lib/cart/live-lines`, so all agree).
 *
 * The resolver always re-evaluates against the live row — so a coupon
 * cookie outlives the promotion's window without ever incorrectly granting
 * an expired discount. Cookies past their natural TTL silently no-op.
 */

const COUPON_COOKIE = "gz.coupon";
const PROMO_URL_COOKIE = "gz.promo";

export type CartPromotion = {
  promotionId: string;
  name: string;
  discountCents: number;
  grantsFreeShipping: boolean;
  source: "code" | "url";
};

export type CartPromotionCandidate = { id: string; source: "code" | "url" };

/**
 * The promotion-id candidates held by the storefront cookie jar, in resolution
 * order: the manual code (`gz.coupon`) first, then the URL-trigger promo
 * (`gz.promo`) as the fallback. Shared by the cart resolver below and the
 * express (quick-buy) action so both pick among the SAME candidates. A
 * malformed (non-UUID) cookie value is ignored rather than queried.
 */
export async function readCartPromotionCandidates(): Promise<CartPromotionCandidate[]> {
  const jar = await cookies();
  const candidates: CartPromotionCandidate[] = [];
  const couponId = jar.get(COUPON_COOKIE)?.value;
  if (couponId && isUuid(couponId)) candidates.push({ id: couponId, source: "code" });
  const urlId = jar.get(PROMO_URL_COOKIE)?.value;
  if (urlId && isUuid(urlId) && urlId !== couponId) candidates.push({ id: urlId, source: "url" });
  return candidates;
}

export async function resolveAppliedCartPromotion(
  subtotalCents: number,
  userId: string | null,
  /** Subtotal of the NON-discounted lines — the base a coupon with
   *  `exclude_discounted_items` applies to. Defaults to the full subtotal. */
  discountableSubtotalCents?: number,
  /** Cart lines — required so a SCOPED coupon (product/category/brand) resolves
   *  its matching-lines base. Omitted ⇒ scoped coupons can't compute a discount. */
  lines?: readonly CouponCartLine[],
): Promise<CartPromotion | null> {
  return resolveCartPromotionFromCandidates(await readCartPromotionCandidates(), {
    subtotalCents,
    userId,
    discountableSubtotalCents,
    lines,
  });
}

/**
 * Cookie-free core of {@link resolveAppliedCartPromotion}: the FIRST candidate
 * (in order) that is currently eligible for this cart context wins; an unknown,
 * expired or non-qualifying one is skipped in favour of the next. Also used by
 * the express workflow, which stages its own one-line cart.
 */
export async function resolveCartPromotionFromCandidates(
  candidates: readonly CartPromotionCandidate[],
  ctx: {
    subtotalCents: number;
    userId: string | null;
    discountableSubtotalCents?: number;
    lines?: readonly CouponCartLine[];
  },
): Promise<CartPromotion | null> {
  if (candidates.length === 0) return null;
  const { subtotalCents, userId, discountableSubtotalCents, lines } = ctx;

  // Resolve the buyer ONCE (targeting + opt-outs) and reuse across candidates.
  const buyer = await resolveBuyerContext(userId);
  for (const c of candidates) {
    const promo = await promotionService.findById(c.id);
    if (!promo) continue;
    // Single source of truth for eligibility (window, min-cart, caps, scope,
    // targeting, opt-outs) shared with place-order — see coupon-eligibility.
    // The cart simply HIDES any coupon that doesn't currently apply.
    const verdict = await evaluateCouponEligibility(promo, {
      cartSubtotalCents: subtotalCents,
      userId,
      buyer,
      discountableSubtotalCents,
      lines,
    });
    if (!verdict.eligible) continue;
    return {
      promotionId: promo.id,
      name: promo.name,
      discountCents: verdict.discountCents,
      grantsFreeShipping: verdict.grantsFreeShipping,
      source: c.source,
    };
  }
  return null;
}

// Re-export the per-line discount type so cart pages don't import it
// from two places.
export type { ProductDiscount };
