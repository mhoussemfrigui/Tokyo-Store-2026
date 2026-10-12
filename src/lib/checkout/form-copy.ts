import "server-only";

import { cache } from "react";

import { getSettingsMap } from "@/modules/cms/setting/queries";

/**
 * Operator-facing CHECKOUT copy — the page title/subtitle, the numbered
 * SECTION titles + descriptions, and the order CTA labels. These were
 * hard-coded literals scattered through `checkout/page.tsx` and
 * `checkout/checkout-form.tsx` after the redesign; this module lifts the
 * genuinely operator-facing ones into the same `checkout.*` settings mechanism
 * the rest of the checkout copy uses (`getCheckoutCopy`), so the store can
 * retune the wording without a deploy.
 *
 * Every field DEFAULTS to the exact string the redesign rendered, so an
 * un-configured store is byte-identical — clearing a setting restores the
 * default (there is no "explicitly empty" state, matching `getAuthPagesConfig`).
 * Trivial form-field micro-labels ("Email *", "Quantité", "Ville") are
 * intentionally NOT here — they stay as inline constants; only titles, section
 * headers and CTAs are operator-tunable.
 *
 * Cached with React.cache so the page + form share one settings read. Never
 * throws: a read failure yields all defaults.
 */

export type CheckoutFormCopy = {
  /** Page header (checkout/page.tsx). */
  pageTitle: string;
  pageSubtitle: string;
  /** Step strip labels (Panier → Livraison → Confirmation). */
  steps: { cart: string; delivery: string; confirmation: string };
  /** Numbered section titles + descriptions (checkout-form.tsx). */
  sections: {
    contact: { title: string; description: string };
    delivery: { title: string; description: string };
    address: { title: string; description: string };
    pickup: { title: string; description: string };
    payment: { title: string; description: string };
  };
  /** Order-summary sidebar heading. */
  summaryHeading: string;
  /** Order CTA labels. `payTemplate` carries a literal `{total}` token. */
  cta: { placeOrder: string; payTemplate: string; submitting: string };
};

export const CHECKOUT_FORM_COPY_DEFAULTS: CheckoutFormCopy = {
  pageTitle: "Finaliser la commande",
  pageSubtitle:
    "Plus qu'une étape — renseignez votre adresse de livraison et confirmez.",
  steps: { cart: "Panier", delivery: "Livraison", confirmation: "Confirmation" },
  sections: {
    contact: {
      title: "Vos coordonnées",
      description: "Pour le suivi de la commande et la confirmation.",
    },
    delivery: {
      title: "Mode de livraison",
      description: "Choisissez comment recevoir votre commande.",
    },
    address: {
      title: "Adresse de livraison",
      description: "Où devons-nous livrer ?",
    },
    pickup: {
      title: "Retrait",
      description: "Vous récupérez votre commande sur place.",
    },
    payment: {
      title: "Mode de paiement",
      description: "Choisissez comment vous souhaitez régler votre commande.",
    },
  },
  summaryHeading: "Récapitulatif",
  cta: {
    placeOrder: "Passer la commande",
    payTemplate: "Payer {total}",
    submitting: "Validation…",
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

export const getCheckoutFormCopy = cache(async (): Promise<CheckoutFormCopy> => {
  let settings: Record<string, string | null> = {};
  try {
    settings = await getSettingsMap();
  } catch {
    return CHECKOUT_FORM_COPY_DEFAULTS;
  }

  const d = CHECKOUT_FORM_COPY_DEFAULTS;
  return {
    pageTitle: text(settings, "checkout.form.page_title", d.pageTitle),
    pageSubtitle: text(settings, "checkout.form.page_subtitle", d.pageSubtitle),
    steps: {
      cart: text(settings, "checkout.form.step_cart", d.steps.cart),
      delivery: text(settings, "checkout.form.step_delivery", d.steps.delivery),
      confirmation: text(
        settings,
        "checkout.form.step_confirmation",
        d.steps.confirmation,
      ),
    },
    sections: {
      contact: {
        title: text(settings, "checkout.form.contact_title", d.sections.contact.title),
        description: text(
          settings,
          "checkout.form.contact_description",
          d.sections.contact.description,
        ),
      },
      delivery: {
        title: text(settings, "checkout.form.delivery_title", d.sections.delivery.title),
        description: text(
          settings,
          "checkout.form.delivery_description",
          d.sections.delivery.description,
        ),
      },
      address: {
        title: text(settings, "checkout.form.address_title", d.sections.address.title),
        description: text(
          settings,
          "checkout.form.address_description",
          d.sections.address.description,
        ),
      },
      pickup: {
        title: text(settings, "checkout.form.pickup_title", d.sections.pickup.title),
        description: text(
          settings,
          "checkout.form.pickup_description",
          d.sections.pickup.description,
        ),
      },
      payment: {
        title: text(settings, "checkout.form.payment_title", d.sections.payment.title),
        description: text(
          settings,
          "checkout.form.payment_description",
          d.sections.payment.description,
        ),
      },
    },
    summaryHeading: text(settings, "checkout.form.summary_heading", d.summaryHeading),
    cta: {
      placeOrder: text(settings, "checkout.form.cta_place_order", d.cta.placeOrder),
      payTemplate: text(settings, "checkout.form.cta_pay_template", d.cta.payTemplate),
      submitting: text(settings, "checkout.form.cta_submitting", d.cta.submitting),
    },
  };
});
