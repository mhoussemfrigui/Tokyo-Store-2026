/**
 * Google Consent Mode v2 helpers.
 *
 * PURE module (no runtime boundary) — shared by the server layout (which bakes
 * the default-consent stub into the page) and the client sync component (which
 * pushes `gtag('consent','update',…)` when the visitor decides).
 *
 * Two distinct concerns live here:
 *  - The pre-consent DEFAULT each of Google's seven signals starts at
 *    (`buildConsentDefaultJs`) — admin-editable per signal (the per-signal
 *    editor), region-scopable, with a "force granted" override for the bypass /
 *    banner-disabled postures.
 *  - The post-decision UPDATE — `signalsFromState` maps our four consent
 *    CATEGORIES onto the seven signals when the visitor chooses.
 *
 * `security_storage` is always granted (auth/fraud, exempt from consent).
 *
 * Refs:
 *  - https://developers.google.com/tag-platform/security/guides/consent
 */

import type { ConsentState } from "@/lib/consent/categories";

export type ConsentSignal =
  | "ad_storage"
  | "ad_user_data"
  | "ad_personalization"
  | "analytics_storage"
  | "functionality_storage"
  | "personalization_storage"
  | "security_storage";

export type ConsentSignalValue = "granted" | "denied";

export type ConsentSignalDefaults = Record<ConsentSignal, ConsentSignalValue>;

/** The seven signals, in a stable order (display + iteration). */
export const CONSENT_SIGNALS: readonly ConsentSignal[] = [
  "analytics_storage",
  "ad_storage",
  "ad_user_data",
  "ad_personalization",
  "functionality_storage",
  "personalization_storage",
  "security_storage",
];

/**
 * Consent Mode strategy.
 *  - "off":      no Consent Mode at all — no default stub; tags load and collect
 *                normally (markets without a consent requirement, or consent
 *                handled entirely inside GTM).
 *  - "basic":    prior blocking — a tag only loads AFTER its consent category is
 *                granted; no cookieless pings.
 *  - "advanced": tags load immediately in a consent-DENIED state (default stub)
 *                so Google can send cookieless pings / model conversions; full
 *                collection after consent. The 2026-recommended setup.
 */
export type ConsentModeStrategy = "off" | "basic" | "advanced";

/**
 * Regions where consent defaults to denied when `region_eea_only` is on.
 *
 * Google Consent Mode's `region` accepts ONLY ISO 3166-2 codes (alpha-2 country
 * codes + subdivisions) — "EU"/"EEA" are NOT valid and are silently ignored, so
 * the EEA must be enumerated country by country (otherwise real EEA visitors fall
 * into the unscoped granted-by-default bucket = tracked without consent). The 30
 * EEA states (27 EU + IS/LI/NO; Greece is GR, not EL) + GB + TN (home market).
 */
export const RESTRICTED_REGIONS = [
  "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR",
  "DE", "GR", "HU", "IE", "IT", "LV", "LT", "LU", "MT", "NL",
  "PL", "PT", "RO", "SK", "SI", "ES", "SE", "IS", "LI", "NO",
  "GB", "TN",
] as const;

/**
 * Translate the visitor's per-category decision into the seven Consent Mode
 * signals. Used by the client sync to push a `consent/update`.
 */
export function signalsFromState(s: ConsentState): ConsentSignalDefaults {
  const g = (b: boolean): ConsentSignalValue => (b ? "granted" : "denied");
  return {
    security_storage: "granted",
    functionality_storage: g(s.functional),
    personalization_storage: g(s.functional),
    analytics_storage: g(s.analytics),
    ad_storage: g(s.marketing),
    ad_user_data: g(s.marketing),
    ad_personalization: g(s.marketing),
  };
}

/** The GDPR-safe pre-decision default — everything denied except security. */
export function deniedSignalDefaults(): ConsentSignalDefaults {
  return {
    security_storage: "granted",
    functionality_storage: "denied",
    personalization_storage: "denied",
    analytics_storage: "denied",
    ad_storage: "denied",
    ad_user_data: "denied",
    ad_personalization: "denied",
  };
}

/** Everything granted — the bypass / banner-disabled posture. */
export function grantedSignalDefaults(): ConsentSignalDefaults {
  return {
    security_storage: "granted",
    functionality_storage: "granted",
    personalization_storage: "granted",
    analytics_storage: "granted",
    ad_storage: "granted",
    ad_user_data: "granted",
    ad_personalization: "granted",
  };
}

/**
 * Build the inline `<script>` body that MUST run before GTM/GA loads: it defines
 * `dataLayer`/`gtag` and sets the default consent state. Every value is a static
 * string / boolean / number serialized via `JSON.stringify`, so the output is
 * injection-safe (same guarantee as the existing dark-mode init).
 *
 *  - `defaults`        — the admin's per-signal pre-consent defaults (the
 *                        per-signal editor). Ignored when `forceGranted`.
 *  - `forceGranted`    — bypass / banner-disabled posture: every signal granted
 *                        from the start, no region scoping (collect from all).
 *  - `regionEeaOnly`   — scope the denied default to RESTRICTED_REGIONS (Google
 *                        grants by default elsewhere — fuller measurement). Moot
 *                        under `forceGranted`.
 *  - `waitForUpdate`   — ms Google waits for a `consent/update` before sending.
 *  - `adsDataRedaction`/`urlPassthrough` — the two Consent Mode `set` flags.
 */
export function buildConsentDefaultJs(opts: {
  defaults: ConsentSignalDefaults;
  forceGranted: boolean;
  regionEeaOnly: boolean;
  waitForUpdate: number;
  adsDataRedaction: boolean;
  urlPassthrough: boolean;
}): string {
  const signals = opts.forceGranted ? grantedSignalDefaults() : opts.defaults;
  const base: Record<string, unknown> = {
    ...signals,
    wait_for_update: opts.waitForUpdate,
  };
  // Region scoping only makes sense when there's something denied to scope.
  if (opts.regionEeaOnly && !opts.forceGranted) base.region = [...RESTRICTED_REGIONS];

  const lines = [
    "window.dataLayer=window.dataLayer||[];",
    "function gtag(){dataLayer.push(arguments);}",
    `gtag('consent','default',${JSON.stringify(base)});`,
  ];
  if (opts.adsDataRedaction) lines.push("gtag('set','ads_data_redaction',true);");
  if (opts.urlPassthrough) lines.push("gtag('set','url_passthrough',true);");
  return lines.join("");
}
