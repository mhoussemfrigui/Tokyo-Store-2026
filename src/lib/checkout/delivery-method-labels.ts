import type { DeliveryMethod } from "@/lib/checkout/delivery";

/**
 * Single source of truth for the customer-facing DELIVERY-METHOD copy, keyed by
 * the `delivery_method` order column. Previously the labels were duplicated as
 * inline literals in BOTH the checkout form (the method picker cards) and the
 * order confirmation page (the summary line) — and had already drifted
 * ("Retrait drive" on checkout vs "Drive" on the order page for the same
 * method). Importing from here keeps them in lockstep.
 *
 * Plain constants (no `server-only`) so the client checkout form AND the
 * server-rendered order page can both import them — mirrors `sort-options.ts`.
 *
 *   - `DELIVERY_METHOD_LABELS` — the short title (used everywhere).
 *   - `DELIVERY_METHOD_DESCRIPTIONS` — the one-line caption the checkout method
 *     cards show under the title.
 */
export const DELIVERY_METHOD_LABELS: Record<DeliveryMethod, string> = {
  home_delivery: "Livraison à domicile",
  drive_by_pickup: "Retrait drive",
  in_store: "Retrait en magasin",
};

export const DELIVERY_METHOD_DESCRIPTIONS: Record<DeliveryMethod, string> = {
  home_delivery: "Un livreur vous apporte la commande à l'adresse indiquée.",
  drive_by_pickup: "Récupérez votre commande sans descendre de la voiture.",
  in_store: "Retirez votre commande directement en boutique.",
};
