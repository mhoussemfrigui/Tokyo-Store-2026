/**
 * PURE Tracking & Analytics config parsing — no "server-only", no DB import, so
 * it can be unit-tested directly (mirrors src/lib/seo/settings-normalize.ts).
 * The async loader lives in config.ts, which re-exports everything here.
 *
 * Tag IDs fall back to the LEGACY `consent.*` keys: this section used to live
 * inside Cookies & RGPD, so existing installs keep working until the owner
 * re-saves under the new tab (no migration, no data loss).
 */

import {
  EVENT_GROUPS,
  type TrackingEventGroup,
  type TrackingFlags,
} from "./event-groups";
import {
  CONSENT_SIGNALS,
  deniedSignalDefaults,
  type ConsentModeStrategy,
  type ConsentSignalDefaults,
  type ConsentSignalValue,
} from "./consent-mode";

// Re-export so existing importers of "@/lib/tracking/config" keep resolving the
// strategy type (it now lives with the Consent Mode helpers).
export type { ConsentModeStrategy };

export type TrackingConfig = {
  /** Master switch — when false NOTHING loads and no consent stub is injected. */
  enabled: boolean;
  /**
   * « Bypass / tout suivre » — when true, collect from EVERYONE regardless of the
   * cookie banner and the visitor's choice (consent forced granted everywhere).
   * The banner may still render but has no effect; the owner takes on the legal
   * responsibility. See src/lib/consent/effective.ts.
   */
  bypassConsent: boolean;
  /** Consent Mode strategy: off | basic (prior-block) | advanced (cookieless). */
  mode: ConsentModeStrategy;
  gtmId: string | null;
  ga4Id: string | null;
  metaPixelId: string | null;
  /** Raw HTML injected (consent-gated) on the storefront — owner-trusted. */
  customHead: string;
  customBody: string;
  /** When true the denied default is scoped to the EEA/GB/TN regions only. */
  regionEeaOnly: boolean;
  /** ms Google waits for a consent/update before sending (Consent Mode). */
  waitForUpdate: number;
  /** gtag('set','ads_data_redaction',…) — redact ad identifiers while denied. */
  adsDataRedaction: boolean;
  /** gtag('set','url_passthrough',…) — pass ad click ids through the URL. */
  urlPassthrough: boolean;
  /** Per-signal PRE-CONSENT defaults (the per-signal editor). */
  signalDefaults: ConsentSignalDefaults;
  /** Per-group activation of the e-commerce funnel events. */
  events: Record<TrackingEventGroup, boolean>;
};

const ID_DISALLOWED = /[^A-Za-z0-9_-]/g;

/** Tag ids are interpolated into inline scripts/URLs — keep only id-safe chars. */
function cleanId(v: string | null | undefined): string | null {
  if (v == null) return null;
  const t = v.replace(ID_DISALLOWED, "");
  return t.length > 0 ? t : null;
}

/**
 * Accepted tag-id FORMATS — an allow-list per field, never a deny-list. The
 * charset filter alone let any id through: the GA4 field is delegable
 * (`system_analytics:update`) and is loaded as `gtag/js?id=<id>`, which serves an
 * UNRESTRICTED Tag Manager container (Custom-HTML tags = arbitrary JS) for a
 * `GTM-` id — bypassing the owner-only GTM rule. So the GA4 field only ever
 * carries a `G-` measurement id, the Pixel field only digits, and the (owner-
 * only) GTM field only a `GTM-` container id. Shared by the save action (refuse)
 * and `parseTrackingConfig` (ignore a bad stored / legacy value).
 */
export const TRACKING_ID_FORMATS = {
  gtm: /^GTM-[A-Z0-9]+$/,
  ga4: /^G-[A-Z0-9]{4,}$/,
  metaPixel: /^\d{5,20}$/,
} as const;
export type TrackingIdKind = keyof typeof TRACKING_ID_FORMATS;

/**
 * Normalize a tag id for `kind`: strip non-id chars, upper-case the Google ids
 * (they are upper-case by spec — a lower-cased paste is a typo, not another
 * id), then return it only if it matches the field's format; otherwise null.
 */
export function normalizeTrackingId(kind: TrackingIdKind, v: string | null | undefined): string | null {
  const t = cleanId(v);
  if (!t) return null;
  const id = kind === "metaPixel" ? t : t.toUpperCase();
  return TRACKING_ID_FORMATS[kind].test(id) ? id : null;
}

function str(v: string | null | undefined): string {
  return (v ?? "").trim();
}

function bool(v: string | null | undefined, fallback: boolean): boolean {
  if (v == null) return fallback;
  const t = v.trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(t)) return true;
  if (["false", "0", "no", "off"].includes(t)) return false;
  return fallback;
}

function clampInt(v: string | null | undefined, fallback: number, lo: number, hi: number): number {
  if (v == null || v.trim() === "") return fallback;
  const n = Number(v.trim());
  if (!Number.isFinite(n)) return fallback;
  return Math.max(lo, Math.min(Math.round(n), hi));
}

function mode(v: string | null | undefined): ConsentModeStrategy {
  const t = v?.trim().toLowerCase();
  if (t === "off") return "off";
  if (t === "basic") return "basic";
  return "advanced";
}

function signalValue(
  v: string | null | undefined,
  fallback: ConsentSignalValue,
): ConsentSignalValue {
  const t = (v ?? "").trim().toLowerCase();
  if (t === "granted") return "granted";
  if (t === "denied") return "denied";
  return fallback;
}

/** Per-signal pre-consent defaults from `tracking.cm_default_<signal>` keys.
 *  `security_storage` is always granted (consent-exempt) and not editable. */
function parseSignalDefaults(s: Record<string, string | null>): ConsentSignalDefaults {
  const base = deniedSignalDefaults();
  const out: ConsentSignalDefaults = { ...base };
  for (const sig of CONSENT_SIGNALS) {
    if (sig === "security_storage") continue; // locked granted
    out[sig] = signalValue(s[`tracking.cm_default_${sig}`], base[sig]);
  }
  return out;
}

/** Build the tracking config from an already-fetched settings map (no DB call). */
export function parseTrackingConfig(s: Record<string, string | null>): TrackingConfig {
  const events = {} as Record<TrackingEventGroup, boolean>;
  for (const g of EVENT_GROUPS) {
    events[g.key] = bool(s[`tracking.evt.${g.key}`], g.defaultEnabled);
  }
  return {
    enabled: bool(s["tracking.enabled"], false),
    bypassConsent: bool(s["tracking.bypass_consent"], false),
    mode: mode(s["tracking.consent_mode"]),
    // New `tracking.*` keys first, then the legacy `consent.*` ids for back-compat.
    // A value that doesn't match its field's format is IGNORED (treated as
    // unset) — a bad row can never load `gtag/js?id=<anything>`.
    gtmId: normalizeTrackingId("gtm", s["tracking.gtm_id"]) ?? normalizeTrackingId("gtm", s["consent.gtm_id"]),
    ga4Id: normalizeTrackingId("ga4", s["tracking.ga4_id"]) ?? normalizeTrackingId("ga4", s["consent.ga_id"]),
    metaPixelId:
      normalizeTrackingId("metaPixel", s["tracking.meta_pixel_id"]) ??
      normalizeTrackingId("metaPixel", s["consent.meta_pixel_id"]),
    customHead: str(s["tracking.custom_head"]),
    customBody: str(s["tracking.custom_body"]),
    regionEeaOnly: bool(s["tracking.region_eea_only"], true),
    waitForUpdate: clampInt(s["tracking.cm_wait_for_update"], 500, 0, 5000),
    adsDataRedaction: bool(s["tracking.cm_ads_data_redaction"], true),
    urlPassthrough: bool(s["tracking.cm_url_passthrough"], true),
    signalDefaults: parseSignalDefaults(s),
    events,
  };
}

/** The public, client-safe subset handed to the script loader (no custom HTML). */
export type ClientTrackingConfig = {
  enabled: boolean;
  mode: ConsentModeStrategy;
  gtmId: string | null;
  ga4Id: string | null;
  metaPixelId: string | null;
};

// NOTE: bypass is intentionally NOT in the client config — it reaches the
// runtime through the ConsentProvider (the `bypass` prop forces consent
// allowed), so the tag loader + funnel collect via the normal isAllowed path.
export function toClientTrackingConfig(cfg: TrackingConfig): ClientTrackingConfig {
  return {
    enabled: cfg.enabled,
    mode: cfg.mode,
    gtmId: cfg.gtmId,
    ga4Id: cfg.ga4Id,
    metaPixelId: cfg.metaPixelId,
  };
}

/**
 * The per-group activation flags exposed to the funnel via `window.__GZ_TRACK_CFG__`.
 * When tracking is disabled, every group is forced off so `track()` no-ops
 * entirely (no dataLayer push, no /api/track hit).
 */
export function clientTrackingFlags(cfg: TrackingConfig): TrackingFlags {
  if (!cfg.enabled) {
    const off = {} as Record<TrackingEventGroup, boolean>;
    for (const g of EVENT_GROUPS) off[g.key] = false;
    return off;
  }
  return cfg.events;
}
