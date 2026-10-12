import "server-only";

import { promotionService, productsMatchingPromoScope } from "@/modules/promotion";
import { countPriorPlacedOrders } from "@/modules/order/queries";
import { resolveBuyerContext, EMPTY_BUYER, type BuyerContext } from "@/lib/promotions/buyer-context";
import { userMatchesRuleTree } from "@/lib/promotions/segments";
import { scopedCouponBaseCents, type CouponCartLine } from "@/lib/promotions/scoped-coupon";
import type { PromotionRow } from "@/modules/promotion/schema";

/**
 * SINGLE source of truth for "can this coupon apply right now?".
 *
 * Handles BOTH cart-scope coupons (discount the whole subtotal) and SCOPED
 * coupons (scope = product/category/brand → discount ONLY the matching cart
 * lines, matched exactly like an auto promo). A scoped coupon's discount is still
 * applied as one order-level reduction (the same `coupon_discount` path) — only
 * its BASE differs (matching lines vs whole subtotal).
 *
 * Both coupon re-evaluation sites call this so they can NEVER diverge:
 *   - cart render        — `resolveAppliedCartPromotion` (src/lib/cart/coupon.ts)
 *   - order placement    — `placeOrderWorkflow` (src/workflows/order/place-order.ts)
 * Both pass `ctx.lines` so scoped coupons resolve their matching base. The apply
 * step (`promotion.evaluate`) may omit lines → scoped eligibility is DEFERRED
 * (accepted with 0 discount; the cart render computes the real cut).
 *
 * The two authoritative sites only differ in how they REACT to an ineligible
 * verdict, not in how eligibility is computed:
 *   - the cart silently hides any ineligible coupon;
 *   - place-order HARD-FAILS the checkout on a genuine validity failure (the
 *     promo is gone / expired / capped — `COUPON_HARD_FAIL_REASONS`) but
 *     silently DROPS the coupon (no discount, no redemption burned) on a soft
 *     "doesn't apply" reason (min-cart miss, no matching items, not targeted, excluded).
 *
 * Check ORDER matters: hard-fail reasons are evaluated FIRST so that, when
 * several conditions fail at once, the returned reason is a hard-fail one.
 *
 * TARGETING + OPT-OUTS (migration 0042): a promo with ANY targets
 * (promotion_targets) applies ONLY to a buyer matching one (customer / segment).
 * A PUBLIC promo (no targets) is suppressed for a buyer who opted out of public
 * promos.
 */
export type CouponIneligibleReason =
  | "inactive"
  | "out_of_window"
  | "exhausted"
  | "per_user_exhausted"
  | "account_required"
  | "no_matching_items"
  | "not_targeted"
  | "not_first_order"
  | "excluded"
  | "min_cart"
  | "max_cart";

export type CouponEligibility =
  | { eligible: true; discountCents: number; grantsFreeShipping: boolean }
  | { eligible: false; reason: CouponIneligibleReason };

/** Reasons that are a genuine validity failure (gone/expired/capped) — these
 *  abort the order at checkout. Everything else is a soft drop. */
export const COUPON_HARD_FAIL_REASONS: ReadonlySet<CouponIneligibleReason> = new Set<
  CouponIneligibleReason
>(["inactive", "out_of_window", "exhausted", "per_user_exhausted"]);

export async function evaluateCouponEligibility(
  promo: PromotionRow,
  ctx: {
    cartSubtotalCents: number;
    userId: string | null;
    now?: number;
    /** Pre-resolved buyer facts (optional). When omitted, resolved on demand from
     *  userId so the targeting/opt-out gates are NEVER silently skipped. */
    buyer?: BuyerContext;
    /** Subtotal of the NON-discounted lines only (lines NOT already cut by an
     *  auto promo). The base a coupon with `exclude_discounted_items` discounts.
     *  Omitted ⇒ falls back to cartSubtotalCents (i.e. behaves as if nothing is
     *  on sale). Both real call sites (cart resolver, place-order) supply it. */
    discountableSubtotalCents?: number;
    /** Cart lines (product id + per-line subtotal). REQUIRED to compute the
     *  matching-lines base for a SCOPED coupon (scope = product/category/brand).
     *  When omitted for a scoped coupon, eligibility is DEFERRED: the non-line
     *  gates (window/caps/targeting/min-max-cart) are checked and, if they pass,
     *  the coupon is accepted with a 0 discount so the apply step can set the
     *  cookie and the cart render (which DOES pass lines) computes the real cut. */
    lines?: readonly CouponCartLine[];
  },
): Promise<CouponEligibility> {
  const now = ctx.now ?? Date.now();

  // ── HARD-FAIL checks (genuine validity; take precedence) ──
  if (!promo.is_active || promo.deleted_at) return { eligible: false, reason: "inactive" };
  if (
    (promo.starts_at && promo.starts_at.getTime() > now) ||
    (promo.ends_at && promo.ends_at.getTime() <= now)
  ) {
    return { eligible: false, reason: "out_of_window" };
  }
  if (!(await promotionService.hasCapacity(promo.id, promo.max_uses))) {
    return { eligible: false, reason: "exhausted" };
  }
  if (promo.max_uses_per_user) {
    // A per-user cap can only be enforced against a STABLE identity. Guests have
    // none — a fresh email/phone per order defeats any contact-based dedup — so
    // for a guest the cap would silently be a no-op and the discount effectively
    // unlimited (OWASP A04). Require an account for any per-user-capped code.
    if (!ctx.userId) return { eligible: false, reason: "account_required" };
    const used = await promotionService.countRedemptionsByUser(promo.id, ctx.userId);
    if (used >= promo.max_uses_per_user) return { eligible: false, reason: "per_user_exhausted" };
  }

  // ── SOFT "doesn't apply right now" checks (drop, never fail the order) ──
  // Targeting + opt-outs. Resolve the buyer once (caller may pre-supply it).
  const targets = await promotionService.listTargets(promo.id);
  const customerTargets = targets.filter((t) => t.target_type === "customer").map((t) => t.target_id);
  const segmentTargets = targets.filter((t) => t.target_type === "segment").map((t) => t.target_id);

  const hasRawTargets = customerTargets.length > 0 || segmentTargets.length > 0;
  // An INLINE audience rule (compound rule_tree over buyer facts) is ALSO a
  // targeting mechanism — a promo carrying one is TARGETED (public opt-outs don't
  // apply). Resolve the buyer ONCE for whichever gates run.
  const hasAudienceRule = promo.audience_rule_tree != null;
  const buyer = ctx.buyer ?? (ctx.userId ? await resolveBuyerContext(ctx.userId) : EMPTY_BUYER);

  if (hasRawTargets || hasAudienceRule) {
    // TARGETED promo — the buyer must satisfy EVERY present audience mechanism
    // (explicit promotion_targets AND the inline rule); each present one narrows.
    if (hasRawTargets) {
      const matched =
        (buyer.profileId != null && customerTargets.includes(buyer.profileId)) ||
        segmentTargets.some((s) => buyer.segmentIds.includes(s));
      if (!matched) return { eligible: false, reason: "not_targeted" };
    }
    if (hasAudienceRule) {
      // A guest (no fact-based identity) matches no audience rule → not targeted.
      const audienceOk = await userMatchesRuleTree(buyer.userId, promo.audience_rule_tree!);
      if (!audienceOk) return { eligible: false, reason: "not_targeted" };
    }
  } else {
    // PUBLIC promo → honor the buyer opt-out.
    if (buyer.promoOptOut) return { eligible: false, reason: "excluded" };
  }

  // New-customer WELCOME coupon → only a buyer's FIRST order. Account-based (a
  // guest has no stable identity to check, so require a signed-in account); a
  // returning customer soft-drops (the code just doesn't apply, never a checkout
  // abort). The order being placed isn't counted yet, so 0 prior = first order.
  if (promo.first_order_only) {
    if (!ctx.userId) return { eligible: false, reason: "account_required" };
    if ((await countPriorPlacedOrders(ctx.userId)) > 0) {
      return { eligible: false, reason: "not_first_order" };
    }
  }

  if (promo.min_cart_cents > 0 && ctx.cartSubtotalCents < promo.min_cart_cents) {
    return { eligible: false, reason: "min_cart" };
  }
  // Optional UPPER bound — brackets a code to a target spend band (soft drop,
  // like min_cart: a too-large cart just doesn't get the coupon).
  if (promo.max_cart_cents != null && ctx.cartSubtotalCents > promo.max_cart_cents) {
    return { eligible: false, reason: "max_cart" };
  }

  // The base the coupon discounts. Depends on scope:
  //   - cart   → the whole subtotal (or the NON-discounted split when
  //              `exclude_discounted_items`, so a code doesn't stack on sale items).
  //   - scoped → ONLY the cart lines matching the coupon's product/category/brand
  //              (matched EXACTLY like an auto promo). No matching line in the cart
  //              → soft-drop (`no_matching_items`). When the caller didn't supply
  //              `lines` (the apply step, which has no priced cart context), DEFER:
  //              accept the coupon with a 0 discount now and let the cart render —
  //              which always passes lines — compute the real cut.
  let discountBase: number;
  if (promo.scope === "cart") {
    discountBase = promo.exclude_discounted_items
      ? ctx.discountableSubtotalCents ?? ctx.cartSubtotalCents
      : ctx.cartSubtotalCents;
  } else {
    if (!ctx.lines) {
      return { eligible: true, discountCents: 0, grantsFreeShipping: promo.grants_free_shipping };
    }
    const matching = await productsMatchingPromoScope(
      promo,
      ctx.lines.map((l) => l.productId),
    );
    discountBase = scopedCouponBaseCents(ctx.lines, matching, promo.exclude_discounted_items);
    if (discountBase <= 0) return { eligible: false, reason: "no_matching_items" };
  }

  // Eligible — recompute the cart-scope discount from the live row + base,
  // honoring the optional percent cap. A free-shipping-only promo yields 0 here.
  let discountCents =
    promo.discount_type === "percent"
      ? Math.round((discountBase * promo.discount_value) / 100)
      : promo.discount_value;
  if (promo.discount_type === "percent" && promo.max_discount_cents != null) {
    discountCents = Math.min(discountCents, promo.max_discount_cents);
  }
  // Never exceed the discountable base (a flat coupon can't discount more than
  // the lines it applies to).
  discountCents = Math.min(discountCents, discountBase);
  return { eligible: true, discountCents, grantsFreeShipping: promo.grants_free_shipping };
}
