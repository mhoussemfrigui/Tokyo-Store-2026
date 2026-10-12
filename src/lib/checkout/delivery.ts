import "server-only";

import { getSettingsMap } from "@/modules/cms/setting/queries";
import {
  deliveryService,
  type DeliveryAgentRow,
  type PickupKind,
  type PickupLocationRow,
} from "@/modules/delivery";

import { previewShipping } from "./shipping";
import { getCheckoutCopy, CHECKOUT_COPY_FALLBACKS } from "./copy";
import {
  applyFreeThreshold,
  normalizeGovernorate,
  type RegionAgentFeeIndex,
} from "./delivery-fee";

/**
 * Authoritative delivery price + order snapshot resolver (server-only).
 *
 * The checkout UI and `/panier` preview list the options the customer can
 * choose (`listDeliveryOptions`), but `resolveDelivery` is the SINGLE SOURCE OF
 * TRUTH for what a chosen method actually costs and what gets snapshotted onto
 * the order. The place-order workflow MUST call `resolveDelivery` and never
 * trust a client-supplied fee.
 *
 * DISPLAY == CHARGE under region pricing: `listDeliveryOptions` (and the client
 * checkout form, via `buildRegionAgentFeeIndex` + the pure helpers in
 * `./delivery-fee`) compute each courier's per-zone fee with the SAME rule
 * `resolveDelivery` uses, so the fee SHOWN equals the fee CHARGED for the
 * customer's gouvernorat. The DB-backed invariant is `delivery-zone.test.ts`.
 *
 * CRITICAL INVARIANT — backwards compatibility: `method = "home_delivery"` with
 * NO `agentId` (and home delivery enabled) resolves to exactly
 * `previewShipping(subtotalCents)` (the legacy global flat-fee + free-threshold
 * path in `./shipping`). Existing orders and the current checkout behave
 * identically; agents/pickups are purely additive.
 *
 * NEVER RE-ROUTED: a disabled method, or a stale / invalid pickup point, is
 * refused with a typed {@link DeliveryUnavailable} — it is never silently turned
 * into a home delivery the customer didn't choose (or the store doesn't offer).
 *
 * CHANNEL: the three method toggles govern what the STOREFRONT offers. Operator
 * callers (manual order, caisse, ERP order push) resolve with
 * `channel: "operator"`, which skips those toggles — a pickup-only e-shop still
 * ships phone / VIP / ERP orders — but still validates the chosen agent /
 * pickup row (enabled, matching kind).
 *
 * Money is integer millimes throughout (see `@/lib/price`). The free-shipping
 * threshold applies to HOME DELIVERY ONLY — pickup fees are flat.
 */

// ──────────────────────────────────────────────────────────── settings

/** Setting keys for the three method-enable toggles (all default ON) + region pricing. */
export const DELIVERY_SETTING_KEYS = {
  homeEnabled: "delivery.home_enabled",
  driveByEnabled: "delivery.drive_by_enabled",
  inStoreEnabled: "delivery.in_store_enabled",
  /** When ON, a chosen courier's fee is taken from its per-zone rate (resolved
   *  from the order's gouvernorat) instead of its flat fee. Default OFF. */
  zonePricingEnabled: "delivery.zone_pricing_enabled",
} as const;

export type DeliveryConfig = {
  /** Home delivery (couriers) offered at all. Default true. */
  homeEnabled: boolean;
  /** Drive-by pickup offered at all. Default true. */
  driveByEnabled: boolean;
  /** In-store pickup offered at all. Default true. */
  inStoreEnabled: boolean;
  /** Region (gouvernorat) pricing for home delivery. Default false. */
  zonePricingEnabled: boolean;
};

const bool = (v: string | null | undefined, d: boolean): boolean =>
  v == null || v === "" ? d : v === "true";

/**
 * Reads the three method-enable flags from site settings (default true each).
 * A disabled method hides its options AND is refused by `resolveDelivery` for a
 * storefront order (typed `DeliveryUnavailable`, never re-routed). Tolerates a
 * missing settings table.
 */
export async function getDeliveryConfig(): Promise<DeliveryConfig> {
  let s: Record<string, string | null> = {};
  try {
    s = await getSettingsMap();
  } catch {
    // Cold DB / missing settings table — every method defaults ON below.
  }
  return {
    homeEnabled: bool(s[DELIVERY_SETTING_KEYS.homeEnabled], true),
    driveByEnabled: bool(s[DELIVERY_SETTING_KEYS.driveByEnabled], true),
    inStoreEnabled: bool(s[DELIVERY_SETTING_KEYS.inStoreEnabled], true),
    zonePricingEnabled: bool(s[DELIVERY_SETTING_KEYS.zonePricingEnabled], false),
  };
}

// ──────────────────────────────────────────────────────────── types

export type DeliveryMethod = "home_delivery" | "drive_by_pickup" | "in_store";

/** A single selectable delivery choice surfaced to the storefront. */
export type DeliveryOption = {
  method: DeliveryMethod;
  /** Agent or pickup-location id; absent for the global home-delivery base. */
  id?: string;
  /** Human label (agent / location name, or the base "standard" label). */
  label: string;
  /** What this option costs, in millimes (already free-threshold-adjusted). */
  feeCents: number;
  /** True when the home-delivery free-shipping threshold zeroed this fee. */
  freeApplied: boolean;
};

/** The authoritative resolved price + the snapshot fields written to the order. */
export type ResolvedDelivery = {
  ok: true;
  /** Authoritative shipping charge in millimes (reuses orders.shipping_cents). */
  shippingCents: number;
  deliveryMethod: DeliveryMethod;
  deliveryAgentId: string | null;
  pickupLocationId: string | null;
  deliveryAgentName: string | null;
  pickupLocationName: string | null;
  pickupLocationAddress: string | null;
};

/**
 * Typed refusal from `resolveDelivery`: the requested method is disabled /
 * unknown, or the chosen pickup point is missing, disabled or of another kind.
 * (A point-less pickup — an operator counter sale — is never refused.)
 * The place-order workflow maps it to `fail("delivery_unavailable", message)`.
 */
export type DeliveryUnavailable = {
  ok: false;
  reason: "method_disabled" | "pickup_unavailable" | "unknown_method";
  /** French, customer-safe. */
  message: string;
};

export type DeliveryResolution = ResolvedDelivery | DeliveryUnavailable;

/** Customer-facing name of each method, as the subject of the refusal message. */
const METHOD_SUBJECT: Record<DeliveryMethod, string> = {
  home_delivery: "La livraison à domicile",
  drive_by_pickup: "Le retrait en drive",
  in_store: "Le retrait en magasin",
};

function unavailable(
  reason: DeliveryUnavailable["reason"],
  method: DeliveryMethod | null,
): DeliveryUnavailable {
  const message =
    reason === "pickup_unavailable"
      ? "Ce point de retrait n'est plus disponible. Choisissez-en un autre."
      : method
        ? `${METHOD_SUBJECT[method]} n'est pas disponible. Choisissez un autre mode de livraison.`
        : "Mode de livraison invalide.";
  return { ok: false, reason, message };
}

// ──────────────────────────────────────────────────────── fee helpers

/** Global home-delivery base rate (flat fee + free threshold), millimes. */
async function getHomeBaseRate(): Promise<{ feeCents: number; freeThresholdCents: number }> {
  const copy = await getCheckoutCopy();
  return {
    feeCents: copy.defaultFeeCents ?? CHECKOUT_COPY_FALLBACKS.defaultFeeCents,
    // Free-shipping disabled ⇒ base threshold 0 ("never free"): the base fee +
    // any NULL-inheriting courier are always charged. Mirrors `previewShipping`
    // so the cart preview and the authoritative order charge stay identical.
    // (A courier with its OWN explicit threshold keeps it — that's a per-courier
    // override, independent of the global offer.)
    freeThresholdCents: copy.freeShippingEnabled
      ? copy.freeThresholdCents ?? CHECKOUT_COPY_FALLBACKS.freeThresholdCents
      : 0,
  };
}

/**
 * Home-delivery fee for one agent (or the global base when `agent` is null),
 * applying the free-shipping threshold. `null` agent fee/threshold INHERIT the
 * global base value. A threshold of 0 means "never free" — the admin sentinel
 * for "no free-shipping offer" on this courier (the delivery schema documents
 * this and the agent form allows 0). To make delivery ALWAYS free you set the
 * FEE itself to 0, not the threshold. `previewShipping` is aligned to the same
 * 0-means-never-free rule so the cart preview and the authoritative order-time
 * charge never disagree.
 */
function homeFeeFor(
  agent: DeliveryAgentRow | null,
  base: { feeCents: number; freeThresholdCents: number },
  subtotalCents: number,
): { feeCents: number; freeApplied: boolean } {
  const fee = agent?.fee_cents ?? base.feeCents;
  const threshold = agent?.free_threshold_cents ?? base.freeThresholdCents;
  return applyFreeThreshold(fee, threshold, subtotalCents);
}

/**
 * Region (gouvernorat) → courier-agent → resolved zone fee, for the client
 * checkout form to recompute the displayed courier fee the instant the customer
 * changes their gouvernorat — WITHOUT a round-trip, and always equal to what
 * `resolveDelivery` will charge. Empty `{}` when region pricing is off.
 *
 * Mirrors `resolveDelivery`'s zone path exactly: `listZones()` returns only
 * ENABLED zones ordered by (display_order, name); the FIRST one containing a
 * gouvernorat claims it (so a later zone can't override — same as
 * `resolveZoneForRegion`); a courier with no rate in the claiming zone is
 * omitted (the form/listing then uses its flat fee); and the threshold is the
 * fully-resolved `rate ?? agent ?? base` value.
 */
export async function buildRegionAgentFeeIndex(): Promise<RegionAgentFeeIndex> {
  const config = await getDeliveryConfig();
  if (!config.zonePricingEnabled) return {};
  const [base, zones, agents, rates] = await Promise.all([
    getHomeBaseRate(),
    deliveryService.listZones(), // enabled only, ordered — first-match wins
    deliveryService.listEnabledAgents(),
    deliveryService.listRates(),
  ]);
  const agentById = new Map(agents.map((a) => [a.id, a]));
  const rateByKey = new Map(rates.map((r) => [`${r.agent_id}:${r.zone_id}`, r]));

  const index: RegionAgentFeeIndex = {};
  const claimed = new Set<string>();
  for (const z of zones) {
    const govs = z.governorates
      .split(",")
      .map((g) => normalizeGovernorate(g))
      .filter(Boolean);
    for (const gov of govs) {
      if (claimed.has(gov)) continue; // first enabled zone wins (resolveZoneForRegion)
      claimed.add(gov);
      const perAgent: Record<string, { feeCents: number; thresholdCents: number }> = {};
      for (const agent of agentById.values()) {
        const rate = rateByKey.get(`${agent.id}:${z.id}`);
        if (!rate) continue; // no override → flat fallback (omit)
        const thresholdCents =
          rate.free_threshold_cents ?? agent.free_threshold_cents ?? base.freeThresholdCents;
        perAgent[agent.id] = { feeCents: rate.fee_cents, thresholdCents };
      }
      if (Object.keys(perAgent).length > 0) index[gov] = perAgent;
    }
  }
  return index;
}

// ──────────────────────────────────────────────────────── option listing

/**
 * Lists the delivery options the customer can choose, per method, with each
 * fee pre-computed for `subtotalCents`. Only ENABLED methods (per
 * `getDeliveryConfig`) and enabled rows are returned.
 *
 *   home:    the global base option (id undefined) + one option per enabled
 *            agent (agent fee/threshold, NULL inherits the global base).
 *   driveBy / inStore: one option per enabled pickup location of that kind
 *            (flat `fee_cents`, no free-threshold).
 *
 * `homeBaseFee` is the global base option's fee (post free-threshold) so the UI
 * can show it without re-deriving.
 */
export async function listDeliveryOptions(
  subtotalCents: number,
  region?: string | null,
): Promise<{
  home: DeliveryOption[];
  driveBy: DeliveryOption[];
  inStore: DeliveryOption[];
  homeBaseFee: number;
}> {
  const config = await getDeliveryConfig();
  const base = await getHomeBaseRate();

  // When region pricing is on AND we already know the order's gouvernorat, the
  // per-courier option fees must reflect the SAME zone rate `resolveDelivery`
  // will charge — otherwise the customer is quoted a flat fee but billed the
  // zone rate. The index resolves region→agent→{fee,threshold} once; agents not
  // covered by a zone rate fall back to their flat fee (mirrors resolveDelivery).
  const zoneIndex =
    config.zonePricingEnabled && region ? await buildRegionAgentFeeIndex() : null;
  // Same normalization the index keys use (accent- + case-insensitive).
  const regionKey = region ? normalizeGovernorate(region) : null;

  // ── Home delivery: global base + per-agent options.
  const home: DeliveryOption[] = [];
  // The base (no-agent) option is NEVER zone-priced — resolveDelivery routes it
  // through previewShipping — so it keeps the flat free-threshold computation.
  const baseFee = homeFeeFor(null, base, subtotalCents);
  if (config.homeEnabled) {
    home.push({
      method: "home_delivery",
      label: "Livraison à domicile",
      feeCents: baseFee.feeCents,
      freeApplied: baseFee.freeApplied,
    });
    const agents = await deliveryService.listEnabledAgents();
    for (const a of agents) {
      const zoned =
        zoneIndex && regionKey ? zoneIndex[regionKey]?.[a.id] : undefined;
      const f = zoned
        ? applyFreeThreshold(zoned.feeCents, zoned.thresholdCents, subtotalCents)
        : homeFeeFor(a, base, subtotalCents);
      home.push({
        method: "home_delivery",
        id: a.id,
        label: a.name,
        feeCents: f.feeCents,
        freeApplied: f.freeApplied,
      });
    }
  }

  // ── Pickup kinds: one flat-fee option per enabled location.
  const pickupOptions = async (
    kind: PickupKind,
    method: DeliveryMethod,
    enabled: boolean,
  ): Promise<DeliveryOption[]> => {
    if (!enabled) return [];
    const locations = await deliveryService.listEnabledPickups(kind);
    return locations.map((l) => ({
      method,
      id: l.id,
      label: l.name,
      feeCents: l.fee_cents,
      freeApplied: false,
    }));
  };

  const [driveBy, inStore] = await Promise.all([
    pickupOptions("drive_by_pickup", "drive_by_pickup", config.driveByEnabled),
    pickupOptions("in_store", "in_store", config.inStoreEnabled),
  ]);

  return { home, driveBy, inStore, homeBaseFee: baseFee.feeCents };
}

// ──────────────────────────────────────────────────────── resolver

export type ResolveDeliveryInput = {
  /** Untrusted client method (absent ⇒ home delivery); an unknown or disabled
   *  method is refused, never re-routed. */
  method?: string | null;
  /** Untrusted agent id (home delivery only). */
  agentId?: string | null;
  /** Untrusted pickup-location id (pickup methods only). */
  pickupLocationId?: string | null;
  /** Order gouvernorat (ship_region) — drives region pricing when enabled. */
  region?: string | null;
  subtotalCents: number;
  /**
   * Who is placing the order. `storefront` (default) enforces the method-enable
   * toggles; `operator` (manual order, caisse, ERP push) skips them — they are
   * storefront visibility settings — but the agent / pickup row is still
   * validated exactly as for a shopper.
   */
  channel?: "storefront" | "operator";
};

/** Home-delivery base snapshot — the legacy `previewShipping` path. */
async function resolveHomeBase(
  subtotalCents: number,
): Promise<ResolvedDelivery> {
  // INVARIANT: must stay exactly previewShipping's global flat-fee + free-threshold.
  const preview = await previewShipping(subtotalCents);
  return {
    ok: true,
    shippingCents: preview.shippingCents,
    deliveryMethod: "home_delivery",
    deliveryAgentId: null,
    pickupLocationId: null,
    deliveryAgentName: null,
    pickupLocationName: null,
    pickupLocationAddress: null,
  };
}

/**
 * THE authoritative price + snapshot for a chosen delivery selection.
 *
 * Validates untrusted input against the live config + DB rows and NEVER throws.
 * A selection the store can't honour is REFUSED with a typed
 * {@link DeliveryUnavailable} (the place-order workflow turns it into
 * `fail("delivery_unavailable")`) — it is never silently re-routed to a home
 * delivery. On success this is the value the place-order workflow writes to
 * `orders.shipping_cents` + the `orders.delivery_*` snapshot columns.
 *
 *  - home_delivery, no agent  → exactly `previewShipping` (legacy invariant).
 *                               Refused when home delivery is disabled
 *                               (storefront channel only).
 *  - home_delivery + agentId  → agent must be enabled; use its fee/threshold
 *                               (NULL inherits the global base). Free-threshold
 *                               applies. Unknown/disabled agent → the home base
 *                               (same method, the « standard » courier option).
 *  - drive_by_pickup / in_store → WITHOUT a pickup id (an operator counter
 *                               sale, e.g. the caisse): keep the method, fee 0,
 *                               no location snapshot — this ignores the
 *                               storefront method toggle, so hiding « Retrait en
 *                               magasin » never blocks the till. (The storefront
 *                               actions reject a location-less pickup upstream,
 *                               so a shopper can't use this to skip a point's fee.)
 *                               With a pickup id: refused when the method is
 *                               disabled (storefront channel only); require an
 *                               ENABLED pickup_location whose `kind` matches
 *                               the method (every channel); use its flat
 *                               `fee_cents`, snapshot name + address — refused
 *                               on any miss.
 *  - any other method string   → refused.
 */
export async function resolveDelivery(
  input: ResolveDeliveryInput,
): Promise<DeliveryResolution> {
  const { agentId, pickupLocationId, region, subtotalCents } = input;
  const method = input.method || "home_delivery";
  const config = await getDeliveryConfig();
  // Storefront method toggles bind shoppers only (see the CHANNEL note above).
  const enforceMethodToggles = (input.channel ?? "storefront") === "storefront";

  // ── Drive-by / in-store pickup.
  if (method === "drive_by_pickup" || method === "in_store") {
    if (!pickupLocationId) {
      // Counter sale / pickup with no named point: the method stands, no fee.
      // Checked BEFORE the method toggle on purpose — that toggle governs the
      // storefront option (« le client retire sa commande… »), and the caisse
      // always sends a point-less in_store with no picker, so an owner hiding
      // the storefront option must not block every till sale. Only operator /
      // caisse / ERP callers reach this: both storefront actions reject a
      // location-less pickup upstream.
      return {
        ok: true,
        shippingCents: 0,
        deliveryMethod: method,
        deliveryAgentId: null,
        pickupLocationId: null,
        deliveryAgentName: null,
        pickupLocationName: null,
        pickupLocationAddress: null,
      };
    }
    const kindEnabled =
      method === "drive_by_pickup" ? config.driveByEnabled : config.inStoreEnabled;
    if (enforceMethodToggles && !kindEnabled) return unavailable("method_disabled", method);
    const loc = await deliveryService.getPickup(pickupLocationId);
    if (loc && loc.enabled && loc.kind === method) {
      return {
        ok: true,
        shippingCents: loc.fee_cents,
        deliveryMethod: method,
        deliveryAgentId: null,
        pickupLocationId: loc.id,
        deliveryAgentName: null,
        pickupLocationName: loc.name,
        pickupLocationAddress: pickupAddressSnapshot(loc),
      };
    }
    // Unknown / disabled / wrong-kind location → refused (a stale selection
    // must not become a courier delivery to a « Retrait — … » placeholder).
    return unavailable("pickup_unavailable", method);
  }

  if (method !== "home_delivery") return unavailable("unknown_method", null);
  if (enforceMethodToggles && !config.homeEnabled) {
    return unavailable("method_disabled", "home_delivery");
  }

  // ── Home delivery with a chosen agent.
  if (agentId) {
    const agent = await deliveryService.getAgent(agentId);
    if (agent && agent.enabled) {
      const base = await getHomeBaseRate();

      // Region pricing (opt-in): when ON and the order's gouvernorat maps to a
      // zone for which THIS courier has a rate, that rate wins over its flat
      // fee. Otherwise (no zone / no rate / toggle off) → the courier flat fee.
      if (config.zonePricingEnabled && region) {
        const zone = await deliveryService.resolveZoneForRegion(region);
        if (zone) {
          const rate = await deliveryService.getAgentZoneRate(agent.id, zone.id);
          if (rate) {
            const threshold = rate.free_threshold_cents ?? agent.free_threshold_cents ?? base.freeThresholdCents;
            const { feeCents } = applyFreeThreshold(rate.fee_cents, threshold, subtotalCents);
            return {
              ok: true,
              shippingCents: feeCents,
              deliveryMethod: "home_delivery",
              deliveryAgentId: agent.id,
              pickupLocationId: null,
              deliveryAgentName: agent.name,
              pickupLocationName: null,
              pickupLocationAddress: null,
            };
          }
        }
      }

      const f = homeFeeFor(agent, base, subtotalCents);
      return {
        ok: true,
        shippingCents: f.feeCents,
        deliveryMethod: "home_delivery",
        deliveryAgentId: agent.id,
        pickupLocationId: null,
        deliveryAgentName: agent.name,
        pickupLocationName: null,
        pickupLocationAddress: null,
      };
    }
    // Unknown/disabled agent → the home base (still the requested method).
  }

  // ── Home delivery with no agent (the legacy flat-rate path).
  return resolveHomeBase(subtotalCents);
}

/** Single-line address snapshot from a pickup location (address, city, region). */
function pickupAddressSnapshot(loc: PickupLocationRow): string | null {
  const parts = [loc.address_line, loc.city, loc.region]
    .map((p) => p?.trim())
    .filter((p): p is string => !!p);
  return parts.length ? parts.join(", ") : null;
}
