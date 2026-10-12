import "server-only";

import { z } from "zod";

import { promotionService } from "@/modules/promotion";
import { evaluateCouponEligibility } from "@/lib/promotions/coupon-eligibility";
import { minorToDinars } from "@/lib/price";
import { fail, ok, workflow } from "../shared";

/**
 * Coupon redemption at checkout.
 *
 * This is the workflow the cart layer calls when a shopper enters a code
 * (applyCouponAction). It returns either the matched promotion + the
 * eligibility verdict, or a structured failure the cart can surface inline.
 * URL-triggered promos (`/promo/<slug>`) don't come through here — that route
 * resolves the slug itself (findLiveByUrlSlug) and sets its own `gz.promo` cookie.
 *
 * Eligibility is computed by the SINGLE source of truth
 * (`evaluateCouponEligibility`) shared with cart render + place-order, so the
 * three sites can NEVER diverge; this workflow only maps the verdict's reason to
 * a shopper-facing French message. `findLiveByCode` already filters active/window
 * at the DB layer, so the inactive/out_of_window reasons are mapped defensively.
 *
 * The redemption is ACTUALLY recorded inside the `placeOrderWorkflow`
 * transaction (`promotionService.incrementUsesCount` + `logRedemption` on
 * the same `tx`) so the `uses_count` bump and `promotion_redemptions`
 * insert are atomic with the order write.
 */

const evaluateSchema = z.object({
  /** The shopper-entered promo code. */
  code: z.string().trim().min(1).max(40),
  /** Cart subtotal in integer minor units (millimes) — enforces `min_cart_cents`. */
  cartSubtotalCents: z.coerce.number().int().min(0),
  /** Logged-in user id (NULL for guest checkouts). */
  userId: z.string().nullable().optional(),
  /** Cart lines (SERVER-built from the cart) so a SCOPED coupon can verify it
   *  has matching items before the cookie is set. Omitted ⇒ scoped eligibility
   *  is deferred to the cart render. */
  lines: z
    .array(
      z.object({
        productId: z.string(),
        lineCents: z.coerce.number().int().min(0),
        baseLineCents: z.coerce.number().int().min(0),
      }),
    )
    .optional(),
});

export const evaluatePromotionWorkflow = workflow<
  [z.input<typeof evaluateSchema>],
  {
    promotionId: string;
    name: string;
    discountCents: number;
    discountType: "percent" | "fixed";
    codeUsed: string | null;
  }
>("promotion.evaluate", async (input) => {
  const parsed = evaluateSchema.safeParse(input);
  if (!parsed.success) return fail("validation", "Validation échouée");
  const d = parsed.data;

  const promo = await promotionService.findLiveByCode(d.code);

  if (!promo) {
    return fail("not_found", "Code ou promotion introuvable / expiré.");
  }

  // Single source of truth — same window/min-cart/cap/per-user/scope/business
  // checks the cart and place-order run. Map the ineligible reason to the
  // shopper-facing message the cart surfaces inline.
  const verdict = await evaluateCouponEligibility(promo, {
    cartSubtotalCents: d.cartSubtotalCents,
    userId: d.userId ?? null,
    lines: d.lines,
  });
  if (!verdict.eligible) {
    switch (verdict.reason) {
      case "not_targeted":
        return fail(
          "not_eligible",
          "Cette promotion est réservée à certains clients ou entreprises.",
        );
      case "excluded":
        return fail(
          "not_eligible",
          "Cette promotion ne s'applique pas à votre compte.",
        );
      case "no_matching_items":
        return fail(
          "not_applicable",
          "Ce code ne s'applique à aucun article de votre panier.",
        );
      case "not_first_order":
        return fail(
          "not_eligible",
          "Cette offre est réservée à votre première commande.",
        );
      case "min_cart": {
        const minTnd = Math.ceil(minorToDinars(promo.min_cart_cents));
        return fail("min_cart", `Cette promotion requiert un panier d'au moins ${minTnd} TND.`);
      }
      case "max_cart": {
        const maxTnd = Math.floor(minorToDinars(promo.max_cart_cents ?? 0));
        return fail("max_cart", `Ce code ne s'applique qu'aux paniers jusqu'à ${maxTnd} TND.`);
      }
      case "exhausted":
        return fail("exhausted", "Cette promotion a atteint sa limite d'utilisations.");
      case "per_user_exhausted":
        return fail("per_user_exhausted", "Vous avez déjà utilisé cette promotion.");
      case "account_required":
        return fail(
          "account_required",
          "Ce code est limité à une utilisation par client — connectez-vous ou créez un compte pour l'utiliser.",
        );
      // inactive / out_of_window are already filtered by findLiveByCode; map them
      // defensively in case the row changes between fetch and evaluation.
      default:
        return fail("not_found", "Code ou promotion introuvable / expiré.");
    }
  }

  return ok({
    promotionId: promo.id,
    name: promo.name,
    discountCents: verdict.discountCents,
    discountType: promo.discount_type,
    codeUsed: promo.code ?? null,
  });
});
