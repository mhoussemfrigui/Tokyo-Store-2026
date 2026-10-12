import "server-only";

import { cache } from "react";

import { getSettingsMap } from "@/modules/cms/setting/queries";

/**
 * Operator-facing CART-page copy — the empty-state, the order-summary heading,
 * the free-shipping-unlocked confirmation, and the coupon-form labels. These
 * were hard-coded literals in `panier/page.tsx` + `panier/coupon-form.tsx`
 * after the redesign; this module lifts the genuinely operator-facing ones into
 * the `cart.*` settings keys so the wording can be retuned without a deploy.
 *
 * Every field DEFAULTS to the exact string the redesign rendered, so an
 * un-configured store is byte-identical (clearing a setting restores the
 * default — same rule as `getAuthPagesConfig` / `getCheckoutFormCopy`). Trivial
 * micro-labels stay inline; only titles / CTAs / the empty-state / coupon
 * labels are operator-tunable here.
 *
 * Cached so the cart page reads settings once. Never throws — a read failure
 * yields all defaults.
 */

export type CartPageCopy = {
  /** Empty-cart marketing view. */
  empty: { eyebrow: string; title: string; message: string; cta: string };
  /** Order-summary card heading + the free-shipping-unlocked confirmation. */
  summary: { heading: string; freeShippingUnlocked: string };
  /** Coupon-form copy (the collapsed toggle, the applied chip, the submit). */
  coupon: { addToggle: string; appliedLabel: string; apply: string };
};

export const CART_PAGE_COPY_DEFAULTS: CartPageCopy = {
  empty: {
    eyebrow: "Votre panier",
    title: "Votre panier est vide",
    message:
      "Parcourez le catalogue et ajoutez vos pièces préférées — elles vous attendront ici.",
    cta: "Découvrir le catalogue",
  },
  summary: {
    heading: "Récapitulatif",
    freeShippingUnlocked: "Livraison offerte débloquée",
  },
  coupon: {
    addToggle: "Ajouter un code promo",
    appliedLabel: "Code appliqué",
    apply: "Appliquer",
  },
};

/** Trimmed setting value, or the fallback when unset/blank. */
function text(
  settings: Record<string, string | null>,
  key: string,
  fallback: string,
): string {
  const v = settings[key]?.trim();
  return v ? v : fallback;
}

export const getCartPageCopy = cache(async (): Promise<CartPageCopy> => {
  let settings: Record<string, string | null> = {};
  try {
    settings = await getSettingsMap();
  } catch {
    return CART_PAGE_COPY_DEFAULTS;
  }

  const d = CART_PAGE_COPY_DEFAULTS;
  return {
    empty: {
      eyebrow: text(settings, "cart.empty.eyebrow", d.empty.eyebrow),
      title: text(settings, "cart.empty.title", d.empty.title),
      message: text(settings, "cart.empty.message", d.empty.message),
      cta: text(settings, "cart.empty.cta", d.empty.cta),
    },
    summary: {
      heading: text(settings, "cart.summary.heading", d.summary.heading),
      freeShippingUnlocked: text(
        settings,
        "cart.summary.free_shipping_unlocked",
        d.summary.freeShippingUnlocked,
      ),
    },
    coupon: {
      addToggle: text(settings, "cart.coupon.add_toggle", d.coupon.addToggle),
      appliedLabel: text(settings, "cart.coupon.applied_label", d.coupon.appliedLabel),
      apply: text(settings, "cart.coupon.apply", d.coupon.apply),
    },
  };
});
