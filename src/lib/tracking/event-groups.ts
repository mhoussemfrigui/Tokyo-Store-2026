/**
 * Tracking event taxonomy — the single source of truth for which GA4 funnel
 * events exist, how they bundle into admin-activatable GROUPS, and the
 * event→group lookup.
 *
 * Intentionally PURE (no "server-only", no "use client", no window/document) so
 * it can be imported by the framework-agnostic funnel (`funnel.ts`), the server
 * config loader (`config.ts`), AND the admin panel without dragging a runtime
 * boundary along — same contract as `src/lib/consent/categories.ts`.
 *
 * Event names follow GA4's recommended e-commerce schema; see
 * https://developers.google.com/analytics/devguides/collection/ga4/reference/events
 */

/** Every funnel event the storefront can emit (GA4 recommended + a few customs). */
export type FunnelEvent =
  | "view_item_list"
  | "select_item"
  | "view_item"
  | "add_to_cart"
  | "remove_from_cart"
  | "view_cart"
  | "add_to_wishlist"
  | "begin_checkout"
  | "add_shipping_info"
  | "add_payment_info"
  | "purchase"
  | "refund"
  | "search"
  | "login"
  | "sign_up"
  | "view_promotion"
  | "select_promotion";

/** Admin-activatable groups. Events bundle into stages (GA4 funnels need whole
 *  stages, not single steps), keeping the admin UI to a handful of toggles. */
export type TrackingEventGroup =
  | "view_item_list"
  | "product"
  | "cart"
  | "wishlist"
  | "checkout"
  | "purchase"
  | "search"
  | "auth"
  | "promotion";

/** Display metadata + default-on state for each group (admin Suivi & Analytics). */
export const EVENT_GROUPS: ReadonlyArray<{
  key: TrackingEventGroup;
  label: string;
  description: string;
  defaultEnabled: boolean;
}> = [
  {
    key: "view_item_list",
    label: "Listes de produits",
    description: "Impressions des produits sur les pages catégorie/marque (view_item_list).",
    defaultEnabled: true,
  },
  {
    key: "product",
    label: "Fiche produit",
    description: "Consultation d'une fiche (view_item) et clic sur un produit d'une liste (select_item).",
    defaultEnabled: true,
  },
  {
    key: "cart",
    label: "Panier",
    description: "Ajout, retrait et consultation du panier (add_to_cart, remove_from_cart, view_cart).",
    defaultEnabled: true,
  },
  {
    key: "wishlist",
    label: "Liste d'envies",
    description: "Ajout à la liste d'envies (add_to_wishlist).",
    defaultEnabled: false,
  },
  {
    key: "checkout",
    label: "Tunnel de commande",
    description: "Début du paiement, livraison et mode de paiement (begin_checkout, add_shipping_info, add_payment_info).",
    defaultEnabled: true,
  },
  {
    key: "purchase",
    // `refund` stays in the FunnelEvent union + EVENT_TO_GROUP for when reversal
    // tracking lands, but it is NOT emitted today: a refund is an ADMIN action, so
    // firing GA4 `refund` from the operator's browser would mis-attribute it to the
    // admin session (the correct path is server-side Measurement Protocol — a
    // future, server-side feature, out of scope for web tracking). So the label
    // promises only what actually fires: `purchase`. Keep this honest until then.
    label: "Achat",
    description: "Conversion d'achat (purchase) — l'événement clé pour le ROI.",
    defaultEnabled: true,
  },
  {
    key: "search",
    label: "Recherche",
    description: "Recherches effectuées sur le site (search).",
    defaultEnabled: false,
  },
  {
    key: "auth",
    // `login` stays in the FunnelEvent union + EVENT_TO_GROUP for when a server-side
    // leg lands, but it is NOT emitted client-side today: every sign-in path
    // (mot de passe, 2FA, OAuth social) completes via a SERVER redirect, so there is
    // no client success point to fire it from. The correct path is server-side
    // Measurement Protocol (a future, server-side feature). So the label promises
    // only what fires: `sign_up`. Keep this honest until then.
    label: "Inscription",
    description: "Création de compte (sign_up). Aucune donnée personnelle n'est envoyée.",
    defaultEnabled: false,
  },
  {
    key: "promotion",
    label: "Promotions internes",
    description:
      "Impressions et clics sur les bannières / encarts promotionnels du site (view_promotion, select_promotion).",
    defaultEnabled: false,
  },
];

const EVENT_TO_GROUP: Record<FunnelEvent, TrackingEventGroup> = {
  view_item_list: "view_item_list",
  select_item: "product",
  view_item: "product",
  add_to_cart: "cart",
  remove_from_cart: "cart",
  view_cart: "cart",
  add_to_wishlist: "wishlist",
  begin_checkout: "checkout",
  add_shipping_info: "checkout",
  add_payment_info: "checkout",
  purchase: "purchase",
  refund: "purchase",
  search: "search",
  login: "auth",
  sign_up: "auth",
  view_promotion: "promotion",
  select_promotion: "promotion",
};

/** Which activatable group an event belongs to. */
export function groupForEvent(event: FunnelEvent): TrackingEventGroup {
  return EVENT_TO_GROUP[event];
}

/**
 * Runtime list of EVERY funnel event — the single source of truth for the
 * `/api/track` allow-list (so the route can't drift from the `FunnelEvent`
 * union). A drift guard in tracking-events.test.ts pins it.
 */
export const ALL_FUNNEL_EVENTS = Object.keys(EVENT_TO_GROUP) as FunnelEvent[];

/** A client-readable map of which groups are active (set on window by the layout). */
export type TrackingFlags = Partial<Record<TrackingEventGroup, boolean>>;

/**
 * Whether an event may fire, given the active-group flags. DEFAULT-ON when the
 * flags object is absent (SSR / tests / HTML rendered before the config global
 * is set) so telemetry degrades gracefully rather than silently going dark on a
 * config glitch. A group is only suppressed when explicitly set to `false`.
 */
export function isEventEnabled(flags: TrackingFlags | undefined | null, event: FunnelEvent): boolean {
  if (!flags) return true;
  return flags[groupForEvent(event)] !== false;
}
