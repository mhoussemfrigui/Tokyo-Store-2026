/**
 * Storefront tracking funnel.
 *
 * The whole point of this file is to give every checkout-related event a
 * single, stable shape that downstream tools (GA4, Plausible Goals, Meta
 * Pixel, server-side analytics) can subscribe to without each touch point
 * needing to know which tool is active.
 *
 *   Component → track("add_to_cart", payload)
 *                              │
 *                              ▼
 *                     window dataLayer push       (GTM / GA4 picks up)
 *                              │
 *                              ▼
 *                     POST /api/track            (single server-side hook for a
 *                                                 FUTURE fan-out — Meta CAPI /
 *                                                 GA4 Measurement Protocol /
 *                                                 Plausible; none is wired, so
 *                                                 it's only sent in development,
 *                                                 where it logs — see
 *                                                 server-mirror.ts)
 *
 * The event names + payload shapes follow GA4's recommended ecommerce
 * schema so when we wire a real provider, nothing here has to change.
 * See https://developers.google.com/analytics/devguides/collection/ga4/reference/events
 *
 * Anything called from a server context falls back to a no-op silently
 * (no `window`). The server-side equivalent of "track" is the in-process
 * `bus.emit` from src/events/bus.ts — used by workflows for audit trail.
 */

import { hasConsent } from "@/lib/consent/state";
import { dinarsToMinor, minorToDinars } from "@/lib/price";
import { slugify } from "@/lib/slug";
import { isEventEnabled, type FunnelEvent, type TrackingFlags } from "./event-groups";
import { serverMirrorActive } from "./server-mirror";

// Re-export so existing imports (`import { type FunnelEvent } from ".../funnel"`)
// keep resolving; the canonical union now lives in event-groups.ts (pure, also
// imported by the admin panel + config loader).
export type { FunnelEvent };

export type FunnelItem = {
  item_id: string;
  item_name: string;
  /** Integer minor units = millimes (e.g. 249990 for 249.99 TND); the
   *  `_cents` name is legacy (see src/lib/price.ts). */
  price_cents: number;
  quantity: number;
  item_brand?: string;
  item_category?: string;
  /** GA4 variant label (e.g. colour/edition). */
  item_variant?: string;
  /** Position of the item in its list — defaults to the array index when unset. */
  index?: number;
  /** List attribution — must match between view_item_list and select_item. */
  item_list_id?: string;
  item_list_name?: string;
};

export type FunnelPayload = {
  /** Optional — set on purchase/refund. */
  transaction_id?: string;
  /** Currency code, ISO 4217. Defaults to "TND". */
  currency?: string;
  /** Total value in minor units (millimes) — for purchase/begin_checkout. */
  value_cents?: number;
  /** Tax in minor units — purchase only (converted to GA4 `tax`). */
  tax_cents?: number;
  /** Shipping in minor units — purchase only (converted to GA4 `shipping`). */
  shipping_cents?: number;
  items?: FunnelItem[];
  /** Free-form metadata spread into the `ecommerce` object (coupon, shipping_tier,
   *  payment_type, item_list_name, search_term, method…). Don't put PII here. */
  meta?: Record<string, string | number | boolean>;
};

declare global {
  interface Window {
    // Holds BOTH GTM-style event objects ({event, ecommerce, …}) AND gtag.js
    // command arrays (['event', name, params]) — the direct-GA4 path pushes the
    // latter so gtag.js (which ignores the free-form objects) records ecommerce.
    dataLayer?: Array<Record<string, unknown> | unknown[]>;
    /** gtag.js command queue fn — defined by the direct-GA4 loader (no GTM). */
    gtag?: (...args: unknown[]) => void;
    /**
     * Tokyo Store-specific queue. Lets other client modules subscribe to
     * funnel events without binding to GTM / GA4 directly. Listen via
     * `window.__GZ_FUNNEL__.push = (e) => ...` (override) or
     * `addEventListener` on a custom DOM event if you want broadcast.
     */
    __GZ_FUNNEL__?: Array<{ event: FunnelEvent; payload: FunnelPayload; ts: number }>;
    /** Pre-consent events held for replay once analytics consent is granted. */
    __GZ_FUNNEL_PENDING__?: Array<{ event: FunnelEvent; payload: FunnelPayload; ts: number }>;
    /**
     * Admin Tracking & Analytics config, baked into the page by the shop layout
     * (a raw inline script, so it's set before hydration). `groups` is the
     * per-event-group activation map; `mode` is the Consent Mode strategy:
     * "advanced" pushes regardless of the cookie decision and lets Google
     * Consent Mode govern transmission; "off" loads tags and sends immediately
     * with no Consent Mode signalling; "basic" holds events until analytics
     * consent. (Bypass / banner-disabled aren't carried here — they reach the
     * funnel via hasConsent() returning true, so events send immediately.)
     */
    __GZ_TRACK_CFG__?: {
      groups?: TrackingFlags;
      mode?: "off" | "basic" | "advanced";
      /** Active store currency code (Devises) — the default for event payloads. */
      currency?: string;
      /**
       * True when the storefront loaded gtag.js DIRECTLY (a GA4 id, NO GTM
       * container). gtag.js ignores the free-form `{event, ecommerce}` objects
       * this funnel pushes to the dataLayer (only a GTM container consumes those),
       * so in that mode `sendToAnalytics` ALSO emits each event via
       * `gtag('event', …)` — otherwise a bare-GA4 install records page views only.
       * Absent / false ⇒ a GTM container (or no Google tag) is active, where the
       * dataLayer push is the right and only channel.
       */
      ga4Direct?: boolean;
    };
  }
}

type EnrichedEvent = { event: FunnelEvent; payload: FunnelPayload; ts: number };

/** Max pre-consent events retained for replay (avoids unbounded growth). */
const PENDING_CAP = 50;

/**
 * Fire a funnel event from a client component.
 *
 *   - Pushes to GTM `dataLayer` so a future GA4 / Meta Pixel hook auto-fires.
 *   - Mirrors to a `__GZ_FUNNEL__` queue for in-app subscribers.
 *   - POSTs to `/api/track` (fire-and-forget) so the server gets the
 *     event even if the browser dies on the next nav — useful for
 *     attribution windows + Meta CAPI later. Only while a server sink
 *     exists (`serverMirrorActive()` — development today).
 *
 * Safe to call from anywhere on the client. Never throws.
 */
export function track(event: FunnelEvent, payload: FunnelPayload = {}): void {
  if (typeof window === "undefined") return;

  const cfg = window.__GZ_TRACK_CFG__;

  // Per-group activation gate (admin → Suivi & Analytics). Checked FIRST so a
  // group the owner turned off never even queues for later replay. Default-on
  // when the config global is absent (SSR / tests / early hydration).
  if (!isEventEnabled(cfg?.groups, event)) return;

  const enriched: EnrichedEvent = {
    event,
    // Default currency = the store's active code (baked into the config global);
    // an explicit payload.currency (e.g. order.currency on purchase) still wins.
    payload: { currency: cfg?.currency ?? "TND", ...payload },
    ts: Date.now(),
  };

  try {
    // In-app subscribers — purely in-memory, no cookie / no network, so this
    // mirror runs regardless of consent (it powers local UI, not third parties).
    window.__GZ_FUNNEL__ = window.__GZ_FUNNEL__ ?? [];
    window.__GZ_FUNNEL__.push(enriched);

    // Consent handling depends on the Consent Mode strategy:
    //  - "advanced": push to the dataLayer regardless of the cookie decision.
    //    Google Consent Mode governs what GOOGLE's tags transmit (cookieless
    //    pings until granted). NON-Google tags (Meta/TikTok/custom) ignore
    //    Consent Mode, so each push carries a `gz_consent` snapshot (see
    //    sendToAnalytics) that those GTM tags MUST gate on — consent enforcement
    //    for them is the owner's GTM trigger config, not this push.
    //  - "basic" (and the safe default when config is absent): the third-party
    //    tags only load AFTER analytics consent, so HOLD (not drop) the event
    //    and replay it the moment consent is granted (see flushFunnelQueue) —
    //    important when consent is decided around checkout, where the
    //    highest-value event would otherwise be lost.
    // "advanced" and "off" load the third-party tags immediately, so events can
    // send right away; "basic" holds them until the tags mount on analytics
    // grant. `hasConsent("analytics")` already returns true under bypass /
    // banner-disabled, so those paths send immediately too.
    const loadAlways = cfg?.mode === "advanced" || cfg?.mode === "off";
    if (!loadAlways && !hasConsent("analytics")) {
      const pending = (window.__GZ_FUNNEL_PENDING__ = window.__GZ_FUNNEL_PENDING__ ?? []);
      pending.push(enriched);
      if (pending.length > PENDING_CAP) pending.splice(0, pending.length - PENDING_CAP);
      return;
    }

    sendToAnalytics(enriched);
  } catch {
    /* analytics must never break a checkout */
  }
}

/** Push one enriched event to the GTM dataLayer + the server mirror. */
function sendToAnalytics(enriched: EnrichedEvent): void {
  const p = enriched.payload;
  // The GA4-recommended ecommerce object, built once and shared by BOTH channels
  // below (the GTM dataLayer push and the direct-GA4 gtag call).
  const ecommerce = {
    currency: p.currency,
    value: p.value_cents != null ? minorToDinars(p.value_cents) : undefined,
    transaction_id: p.transaction_id,
    tax: p.tax_cents != null ? minorToDinars(p.tax_cents) : undefined,
    shipping: p.shipping_cents != null ? minorToDinars(p.shipping_cents) : undefined,
    items: p.items?.map((it, i) => ({
      item_id: it.item_id,
      item_name: it.item_name,
      price: minorToDinars(it.price_cents),
      quantity: it.quantity,
      item_brand: it.item_brand,
      item_category: it.item_category,
      item_variant: it.item_variant,
      // Derive a stable item_list_id from the list name when the caller didn't
      // set one, so GA4 can join a list impression (view_item_list) → the click
      // (select_item) → the purchase. Same scheme on every surface.
      item_list_id: it.item_list_id ?? (it.item_list_name ? slugify(it.item_list_name) : undefined),
      item_list_name: it.item_list_name,
      index: it.index ?? i,
    })),
    ...p.meta,
  };

  // GTM dataLayer — standard ecommerce shape so a GTM container's tags pick it up.
  window.dataLayer = window.dataLayer ?? [];
  // Clear-before-push: GTM does a RECURSIVE merge of dataLayer, so items from a
  // previous event bleed into the next one. Pushing `ecommerce: null` first
  // resets it (GA4 e-commerce convention).
  window.dataLayer.push({ ecommerce: null });
  window.dataLayer.push({
    event: enriched.event,
    // Current consent snapshot so NON-Google tags in the GTM container (Meta,
    // TikTok, custom snippets) can gate their triggers on it — Google Consent
    // Mode only governs Google's OWN tags, so in advanced mode this is the
    // signal owners must check before firing a marketing tag.
    gz_consent: {
      analytics: hasConsent("analytics"),
      marketing: hasConsent("marketing"),
    },
    ecommerce,
  });

  // Direct GA4 (gtag.js, NO GTM container): gtag.js does NOT consume the
  // free-form dataLayer objects above — only a GTM container does — so without
  // this a bare-GA4 install would record page_view only and drop every
  // ecommerce event. The funnel event names already follow GA4's recommended
  // schema, so they map 1:1 to gtag('event', …); consent is handled separately
  // by Consent Mode (ConsentModeSync's gtag('consent','update')), so the params
  // carry ecommerce only (no gz_consent, which is a GTM-variable concept).
  if (window.__GZ_TRACK_CFG__?.ga4Direct) {
    // The gtag loader runs `afterInteractive`, which can land AFTER a mount-time
    // impression effect (view_item / view_promotion). Define the canonical stub
    // when it hasn't yet, so the call QUEUES into the dataLayer and gtag.js
    // replays it on load — otherwise an early event is lost (gtag.js ignores the
    // plain {event} object pushed above). A later real gtag.js just reuses the
    // same dataLayer queue.
    const gtag =
      window.gtag ??
      (window.gtag = (...args: unknown[]) => {
        (window.dataLayer = window.dataLayer ?? []).push(args);
      });
    gtag("event", enriched.event, ecommerce);
  }

  // Server-side mirror — `keepalive` so it survives an immediate navigation
  // (common right after add_to_cart / purchase). No await; we don't want
  // analytics to gate UX. Skipped while no server fan-out consumes it (every
  // production event would otherwise cost the route DB round-trips for nothing).
  if (!serverMirrorActive()) return;
  fetch("/api/track", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(enriched),
    keepalive: true,
  }).catch(() => {
    /* analytics must never break a checkout */
  });
}

/**
 * Replay events captured before consent, once analytics consent is granted.
 * Called by the ConsentProvider when the analytics category flips to allowed so
 * the pre-consent entry-page view / purchase reaches GA4/GTM + the server mirror
 * instead of being lost.
 */
export function flushFunnelQueue(): void {
  if (typeof window === "undefined") return;
  if (!hasConsent("analytics")) return;
  const pending = window.__GZ_FUNNEL_PENDING__;
  if (!pending || pending.length === 0) return;
  window.__GZ_FUNNEL_PENDING__ = [];
  for (const enriched of pending) {
    try {
      sendToAnalytics(enriched);
    } catch {
      /* never throw from telemetry */
    }
  }
}

/**
 * Convenience builder for product-shaped items. `item_id` is the product UUID
 * (`id`) — the ONE scheme every funnel event uses (listing view_item_list /
 * select_item, PDP view_item, cart, purchase), so GA4 can join a list
 * impression to the purchase. Pass it whenever the caller has it (the storefront
 * `Product` DTO carries `id`); the slug is only a fallback for hand-built objects.
 */
export function itemFromProduct(p: {
  /** Product UUID — the canonical GA4 item_id. */
  id?: string;
  slug: string;
  name: string;
  price: number;
  /** Canonical minor units (millimes) — when supplied, used verbatim instead
   *  of re-deriving from the major-unit `price`. */
  priceCents?: number;
  brand?: string;
  category?: string;
  quantity?: number;
}): FunnelItem {
  return {
    item_id: p.id ?? p.slug,
    item_name: p.name,
    // Prefer the canonical minor units from the catalog mapper. The
    // `dinarsToMinor(price)` re-derivation stays as a fallback for callers
    // that construct ad-hoc product-shaped objects — it's the same rounding
    // drift this field exists to eliminate, but it keeps the helper drop-in.
    price_cents: p.priceCents ?? dinarsToMinor(p.price),
    quantity: p.quantity ?? 1,
    item_brand: p.brand,
    item_category: p.category,
  };
}
