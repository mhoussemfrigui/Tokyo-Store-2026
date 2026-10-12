import "server-only";

import { getSettingsMap } from "@/modules/cms/setting/queries";
import { deliveryService } from "@/modules/delivery";
import {
  listDeliveryOptions,
  buildRegionAgentFeeIndex,
  type DeliveryOption,
} from "@/lib/checkout/delivery";
import { previewShipping } from "@/lib/checkout/shipping";
import type { RegionAgentFeeIndex } from "@/lib/checkout/delivery-fee";

/**
 * Admin-controllable quick-buy form schema.
 *
 * The admin edits these via the dedicated pages: `/admin/system/express`
 * owns the express form-field toggles + master on/off, `/admin/system/payments`
 * owns the allowed payment methods (cod_enabled, cod_label, and the per-gateway
 * enable flags). There is NO express-specific payment routing: BOTH the cart
 * and the express ("Acheter maintenant") flow offer the same enabled methods
 * and the customer always chooses COD vs an online gateway. Each field defaults
 * to a sensible value, so a fresh deploy works without any setting rows.
 *
 * Settings keys (all under `checkout.quick.*`):
 *
 *   checkout.quick.email_enabled          (bool, default false)
 *   checkout.quick.email_required         (bool, default false)
 *   checkout.quick.city_enabled           (bool, default false)
 *   checkout.quick.street_line2_enabled   (bool, default false)
 *   checkout.quick.region_enabled         (bool, default false)
 *   checkout.quick.postal_code_enabled    (bool, default false)
 *   checkout.quick.notes_enabled          (bool, default false)
 *   checkout.quick.cod_enabled            (bool, default true)
 *   checkout.quick.cod_label              (string, default "Paiement à la livraison")
 *
 * Always-on fields (cannot be hidden — order won't ship without them):
 *   full_name, phone, street_line1
 *   (phone is a hard requirement — the toggle keys were removed; see the note
 *    below where the resolver hardcodes phone { enabled: true, required: true }.)
 *
 * Default form (minimal): name + phone + adresse + COD radio. Admin
 * opts in to extra fields (email, city, gouvernorat, notes…) only when
 * needed — the riders call to clarify anything missing. Quick-buy is a
 * 1-tap path.
 *
 * Returning a plain object keeps the client component tiny — no live
 * setting reads in the browser, no flash-of-wrong-fields.
 */

export type QuickBuyConfig = {
  /** Master switch — when false the storefront hides the express ("Acheter
   *  maintenant") button entirely and customers go through the cart. */
  enabled: boolean;
  fields: {
    email: { enabled: boolean; required: boolean };
    phone: { enabled: boolean; required: boolean };
    city: { enabled: boolean };
    streetLine2: { enabled: boolean };
    region: { enabled: boolean };
    postalCode: { enabled: boolean };
    notes: { enabled: boolean };
  };
  payment: {
    codEnabled: boolean;
    codLabel: string;
    /** COD radio caption (e.g. "En espèces à la réception…"). Read from
     *  `checkout.payment.cod_description`; no admin panel writes it today, so it
     *  always renders the default literal (see resolver note below). */
    codDescription: string;
    /** Online gateways — rendered as extra radios when enabled in settings. */
    clictopayEnabled: boolean;
    /** ClicToPay radio title + caption — code defaults; not yet admin-editable. */
    clictopayLabel: string;
    clictopayDescription: string;
    flouciEnabled: boolean;
    /** Flouci radio title + caption — code defaults; not yet admin-editable. */
    flouciLabel: string;
    flouciDescription: string;
  };
  /**
   * Delivery selector data for the quick-buy form. Each list holds the
   * ENABLED options for its method, with a fee pre-computed at the config's
   * `subtotalCents` (the PDP loader passes 0 ⇒ base fees with no free-shipping
   * threshold applied — the express form re-applies `homeFreeThresholds` against
   * price × quantity; the AUTHORITATIVE fee is recomputed server-side by
   * `resolveDelivery` at order time). The form only renders a method picker
   * when more than one method (or more than one home option) is available;
   * a single home-only setup keeps the legacy 1-tap flow untouched.
   *
   * Submission field names (mirrors the place-order workflow input):
   *   deliveryMethod, deliveryAgentId, pickupLocationId.
   */
  /** The subtotal the delivery fees were computed for (millimes) — the client
   *  reuses it to recompute zone fees so its free-threshold math matches. */
  subtotalCents: number;
  delivery: {
    homeEnabled: boolean;
    driveByEnabled: boolean;
    inStoreEnabled: boolean;
    /** Home delivery: the global base (id undefined) + one per enabled agent. */
    home: DeliveryOption[];
    /** Drive-by pickup locations (flat fee each). */
    driveBy: DeliveryOption[];
    /** In-store pickup locations (flat fee each). */
    inStore: DeliveryOption[];
    /** Region→courier zone-fee index (region pricing only; `{}` otherwise) so
     *  the express selector shows the zone fee that will actually be charged. */
    zoneFeeIndex: RegionAgentFeeIndex;
    /** Free-shipping threshold (millimes; 0 = never free) of each HOME option,
     *  keyed by agent id — `""` for the global base option. The PDP builds the
     *  fees at subtotal 0, so the express form re-applies these against the
     *  product price × quantity (`applyFreeThreshold`) to show the fee
     *  `resolveDelivery` will actually charge (e.g. « Offerte » above 250 TND).
     *  Mirrors `homeFeeFor`: an agent's NULL threshold inherits the base one. */
    homeFreeThresholds: Record<string, number>;
  };
};

const bool = (v: string | null | undefined, fallback: boolean): boolean => {
  if (v == null) return fallback;
  const s = v.trim().toLowerCase();
  if (s === "true" || s === "1" || s === "yes" || s === "on") return true;
  if (s === "false" || s === "0" || s === "no" || s === "off") return false;
  return fallback;
};

/** The payment methods the app can actually charge today (no `card_stripe`). */
export type PayableMethod = "cod" | "clictopay" | "flouci";

const ONLINE_METHODS = ["clictopay", "flouci"] as const;
type OnlineMethod = (typeof ONLINE_METHODS)[number];

export type ResolvedPaymentMethod =
  | { ok: true; method: PayableMethod }
  | { ok: false; message: string };

/**
 * AUTHORITATIVE server-side resolution of a submitted payment method against
 * the admin's payment config. The checkout / quick-buy FORMS only hide UI
 * radios — this is the single gate that actually enforces the admin toggles, so
 * a tampered or scripted POST cannot: (a) pay through a gateway the admin
 * disabled, or (b) use COD when COD is off. Both place-order actions route
 * through this so the two flows behave identically — the customer always
 * chooses among the enabled methods. An unimplemented/unknown method (e.g.
 * legacy `card_stripe`) is treated as a COD-intent and resolved to a live
 * method, never charged as-is.
 */
export function resolvePaymentMethod(
  requested: string | null | undefined,
  payment: QuickBuyConfig["payment"],
): ResolvedPaymentMethod {
  const enabledGateways: OnlineMethod[] = ONLINE_METHODS.filter((m) =>
    m === "clictopay" ? payment.clictopayEnabled : payment.flouciEnabled,
  );
  const req = (requested ?? "").trim().toLowerCase();

  // An online gateway was explicitly requested → it MUST be enabled.
  if ((ONLINE_METHODS as readonly string[]).includes(req)) {
    if (enabledGateways.includes(req as OnlineMethod)) {
      return { ok: true, method: req as OnlineMethod };
    }
    return { ok: false, message: "Ce moyen de paiement n'est pas disponible." };
  }

  // Otherwise it's a COD intent (incl. empty / unknown / legacy card_stripe).
  if (payment.codEnabled) return { ok: true, method: "cod" };

  // COD disabled — fall back to a gateway if any exists, else the store has no
  // usable payment method (a misconfiguration).
  if (enabledGateways.length > 0) return { ok: true, method: enabledGateways[0] };
  return { ok: false, message: "Aucun moyen de paiement n'est disponible." };
}

/**
 * Sanitise an admin-entered COD label before persisting. A COD label is never an
 * email — but the Paiement settings form carries password fields, so a browser
 * password manager can autofill the operator's saved login email into the
 * (empty) label field, which would then render as the storefront's COD option
 * title ("admin@tokyostore.tn"). Reject an email-shaped value (→ null, which
 * falls back to the "Paiement à la livraison" default downstream) and cap the
 * length. The regex is ANCHORED so a legitimate label that merely contains "@"
 * (e.g. "Payer @ domicile") is preserved. This is the AUTHORITATIVE guard —
 * `autoComplete="off"` on the field is only a best-effort hint browsers may
 * ignore for credential fields.
 */
export function sanitizeCodLabel(raw: string | null | undefined): string | null {
  const s = (raw ?? "").trim();
  if (!s) return null;
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return null;
  return s.slice(0, 80).trim();
}

/**
 * Free-shipping threshold per HOME delivery option (see
 * `QuickBuyConfig.delivery.homeFreeThresholds`): the global base threshold
 * (`previewShipping` — 0 when the free-shipping offer is off) under `""`, and
 * each enabled courier's own threshold, a NULL one inheriting the base (same
 * rule as `homeFeeFor` in `@/lib/checkout/delivery`).
 */
async function resolveHomeFreeThresholds(): Promise<Record<string, number>> {
  const [base, agents] = await Promise.all([
    previewShipping(0),
    deliveryService.listEnabledAgents(),
  ]);
  const out: Record<string, number> = { "": base.freeThresholdCents };
  for (const a of agents) out[a.id] = a.free_threshold_cents ?? base.freeThresholdCents;
  return out;
}

/**
 * Build the quick-buy form config.
 *
 * `subtotalCents` parameterises only the DELIVERY fee preview: callers that
 * render the form against a known cart subtotal can pass it so the displayed
 * fees reflect the free-shipping threshold; the PDP loader leaves it at the
 * default (0) — the option fees then carry the base rate and the express form
 * applies `delivery.homeFreeThresholds` to the live price × quantity itself. The
 * authoritative fee is recomputed server-side by `resolveDelivery` at order
 * time (it never trusts the client fee). All other config sections are
 * subtotal-free.
 */
export async function getQuickBuyConfig(
  subtotalCents = 0,
): Promise<QuickBuyConfig> {
  let settings: Record<string, string | null> = {};
  try {
    settings = await getSettingsMap();
  } catch {
    // Settings table unavailable (boot order on a fresh DB) — fall back to
    // defaults so the storefront still renders a usable form.
  }

  // Delivery options — only ENABLED methods/rows, fee pre-computed for the
  // given subtotal. Degrades to home-only on any failure so the form still
  // renders the legacy 1-tap flow.
  let delivery: QuickBuyConfig["delivery"] = {
    homeEnabled: true,
    driveByEnabled: false,
    inStoreEnabled: false,
    home: [],
    driveBy: [],
    inStore: [],
    zoneFeeIndex: {},
    homeFreeThresholds: {},
  };
  try {
    const [opts, zoneFeeIndex, homeFreeThresholds] = await Promise.all([
      listDeliveryOptions(subtotalCents),
      buildRegionAgentFeeIndex(),
      resolveHomeFreeThresholds(),
    ]);
    delivery = {
      // `listDeliveryOptions` already filters by the method-enable flags: a
      // disabled method returns an empty list, so non-empty ⇒ enabled.
      homeEnabled: opts.home.length > 0,
      driveByEnabled: opts.driveBy.length > 0,
      inStoreEnabled: opts.inStore.length > 0,
      home: opts.home,
      driveBy: opts.driveBy,
      inStore: opts.inStore,
      zoneFeeIndex,
      homeFreeThresholds,
    };
  } catch {
    // Cold DB / missing delivery tables — keep the home-only default above.
  }

  return {
    // Master on/off — express ("Acheter maintenant") is offered unless the
    // operator disabled it on the Achat-express page (null ⇒ on by default).
    enabled: bool(settings["checkout.quick.enabled"], true),
    subtotalCents,
    delivery,
    fields: {
      email: {
        enabled: bool(settings["checkout.quick.email_enabled"], false),
        required: bool(settings["checkout.quick.email_required"], false),
      },
      phone: {
        // Phone is a HARD, non-toggleable requirement on EVERY order (express +
        // full cart): a COD / delivery order in Tunisia needs a reachable
        // number. It used to be hideable via `checkout.quick.phone_enabled`,
        // which — once a falsy value was persisted (e.g. an express-settings
        // save) — made the field silently vanish from both forms. Always shown,
        // always required.
        enabled: true,
        required: true,
      },
      city: {
        // City is technically required to deliver, but the rider can
        // confirm by phone for the quick-buy flow. Admin can opt in if
        // they want the customer to type it upfront.
        enabled: bool(settings["checkout.quick.city_enabled"], false),
      },
      streetLine2: {
        enabled: bool(settings["checkout.quick.street_line2_enabled"], false),
      },
      region: {
        enabled: bool(settings["checkout.quick.region_enabled"], false),
      },
      postalCode: {
        enabled: bool(settings["checkout.quick.postal_code_enabled"], false),
      },
      notes: {
        enabled: bool(settings["checkout.quick.notes_enabled"], false),
      },
    },
    payment: {
      codEnabled: bool(settings["checkout.quick.cod_enabled"], true),
      codLabel:
        settings["checkout.quick.cod_label"]?.trim() ||
        "Paiement à la livraison",
      // COD/gateway captions + labels are read from `checkout.payment.*`, each
      // defaulting to the current storefront literal. NOTE: these caption/label
      // keys are NOT yet exposed in any admin panel — only the `*_enabled`
      // toggles and `checkout.quick.cod_label` are operator-editable today — so
      // they always render the defaults below until a settings field is wired.
      codDescription:
        settings["checkout.payment.cod_description"]?.trim() ||
        "En espèces à la réception. Aucun frais supplémentaire.",
      clictopayEnabled: bool(settings["checkout.payment.clictopay_enabled"], false),
      clictopayLabel:
        settings["checkout.payment.clictopay_label"]?.trim() || "ClicToPay",
      clictopayDescription:
        settings["checkout.payment.clictopay_description"]?.trim() ||
        "Carte bancaire — Monétique Tunisie",
      flouciEnabled: bool(settings["checkout.payment.flouci_enabled"], false),
      flouciLabel:
        settings["checkout.payment.flouci_label"]?.trim() || "Flouci",
      flouciDescription:
        settings["checkout.payment.flouci_description"]?.trim() ||
        "Carte bancaire",
    },
  };
}
