/**
 * Pure Tracking & Analytics config parsing (parse-config.ts) — defaults, the
 * legacy consent.* fallback, id sanitization + per-field FORMAT allow-list
 * (GA4 `G-…`, Pixel digits, GTM `GTM-…`), mode normalization, bool coercion,
 * and the master-off flag forcing. No DB (that's why parse-config is split out
 * of the server-only config.ts).
 *
 * Run:
 *   pnpm exec tsx --conditions=react-server src/lib/db/tests/tracking-parse-config.test.ts
 */
import {
  parseTrackingConfig,
  toClientTrackingConfig,
  clientTrackingFlags,
  normalizeTrackingId,
} from "@/lib/tracking/parse-config";
import { EVENT_GROUPS } from "@/lib/tracking/event-groups";

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.error(`  ✗ ${label}`);
  }
}

function main() {
  console.log("defaults (empty map):");
  const d = parseTrackingConfig({});
  check("enabled → false (opt-in)", d.enabled === false);
  check("mode → advanced", d.mode === "advanced");
  check("ids → null", d.gtmId === null && d.ga4Id === null && d.metaPixelId === null);
  check("custom head/body → ''", d.customHead === "" && d.customBody === "");
  check("regionEeaOnly → true", d.regionEeaOnly === true);
  check(
    "events == EVENT_GROUPS defaults",
    EVENT_GROUPS.every((g) => d.events[g.key] === g.defaultEnabled),
  );

  console.log("legacy consent.* fallback:");
  check(
    "tracking.* WINS over consent.*",
    parseTrackingConfig({ "tracking.ga4_id": "G-NEW2024", "consent.ga_id": "G-OLD2023" }).ga4Id === "G-NEW2024",
  );
  check(
    "falls back to consent.ga_id → ga4Id",
    parseTrackingConfig({ "consent.ga_id": "G-OLD2023" }).ga4Id === "G-OLD2023",
  );
  check(
    "falls back to consent.gtm_id → gtmId",
    parseTrackingConfig({ "consent.gtm_id": "GTM-OLD" }).gtmId === "GTM-OLD",
  );
  check(
    "falls back to consent.meta_pixel_id → metaPixelId",
    parseTrackingConfig({ "consent.meta_pixel_id": "123456" }).metaPixelId === "123456",
  );

  console.log("id sanitization:");
  check(
    "strips non-id chars (then upper-cases a Google id)",
    parseTrackingConfig({ "tracking.ga4_id": "G-1<script>" }).ga4Id === "G-1SCRIPT",
  );
  check("whitespace-only → null", parseTrackingConfig({ "tracking.gtm_id": "   " }).gtmId === null);
  check(
    "keeps a well-formed GTM id",
    parseTrackingConfig({ "tracking.gtm_id": "GTM-AB12CD" }).gtmId === "GTM-AB12CD",
  );

  console.log("id FORMAT allow-list (a bad stored value is ignored):");
  // THE escalation vector: a GTM container id in the delegable GA4 field would be
  // loaded as gtag/js?id=GTM-… = an unrestricted Tag Manager container.
  check("GTM- id in the GA4 field → null", parseTrackingConfig({ "tracking.ga4_id": "GTM-ATTACKR" }).ga4Id === null);
  check(
    "…also via the legacy consent.ga_id fallback",
    parseTrackingConfig({ "consent.ga_id": "GTM-ATTACKR" }).ga4Id === null,
  );
  check(
    "a bad tracking.ga4_id falls back to a valid legacy consent.ga_id",
    parseTrackingConfig({ "tracking.ga4_id": "GTM-ATTACKR", "consent.ga_id": "G-LEGACY01" }).ga4Id === "G-LEGACY01",
  );
  check("GT-/AW- ids are not GA4 → null", normalizeTrackingId("ga4", "GT-ABCDE") === null && normalizeTrackingId("ga4", "AW-12345") === null);
  check("G- with < 4 chars → null", normalizeTrackingId("ga4", "G-AB1") === null);
  check("underscore in a GA4 id → null", normalizeTrackingId("ga4", "G-AB_12") === null);
  check("real-shaped GA4 id kept", normalizeTrackingId("ga4", "G-ABC123XYZ9") === "G-ABC123XYZ9");
  check("lower-cased GA4 paste → upper-cased", normalizeTrackingId("ga4", " g-abc123xyz9 ") === "G-ABC123XYZ9");
  check("Pixel: digits kept", parseTrackingConfig({ "tracking.meta_pixel_id": "1234567890123456" }).metaPixelId === "1234567890123456");
  check("Pixel: letters → null", parseTrackingConfig({ "tracking.meta_pixel_id": "GTM-ATTACKR" }).metaPixelId === null);
  check("Pixel: < 5 digits → null", normalizeTrackingId("metaPixel", "1234") === null);
  check("Pixel: > 20 digits → null", normalizeTrackingId("metaPixel", "1".repeat(21)) === null);
  check("GTM field: a G- id → null", parseTrackingConfig({ "tracking.gtm_id": "G-ABC123XYZ9" }).gtmId === null);
  check("GTM field: underscore → null", normalizeTrackingId("gtm", "GTM-AB_12") === null);
  check("empty / null → null", normalizeTrackingId("ga4", "") === null && normalizeTrackingId("gtm", null) === null);

  console.log("mode normalization:");
  check("'basic' → basic", parseTrackingConfig({ "tracking.consent_mode": "basic" }).mode === "basic");
  check("'BASIC' → basic", parseTrackingConfig({ "tracking.consent_mode": "BASIC" }).mode === "basic");
  check("' basic ' → basic", parseTrackingConfig({ "tracking.consent_mode": " basic " }).mode === "basic");
  check("'advanced' → advanced", parseTrackingConfig({ "tracking.consent_mode": "advanced" }).mode === "advanced");
  check("'garbage' → advanced", parseTrackingConfig({ "tracking.consent_mode": "garbage" }).mode === "advanced");
  check("'' → advanced", parseTrackingConfig({ "tracking.consent_mode": "" }).mode === "advanced");

  console.log("event-group bool coercion:");
  check("'off' → false", parseTrackingConfig({ "tracking.evt.product": "off" }).events.product === false);
  check("'on' → true", parseTrackingConfig({ "tracking.evt.wishlist": "on" }).events.wishlist === true);
  check(
    "junk → group default (product defaults true)",
    parseTrackingConfig({ "tracking.evt.product": "maybe" }).events.product === true,
  );

  console.log("clientTrackingFlags:");
  const onCfg = parseTrackingConfig({ "tracking.enabled": "true", "tracking.evt.search": "true" });
  check(
    "enabled → returns cfg.events verbatim",
    clientTrackingFlags(onCfg).search === true && clientTrackingFlags(onCfg).wishlist === false,
  );
  const offCfg = parseTrackingConfig({ "tracking.enabled": "false", "tracking.evt.product": "true" });
  check(
    "disabled → EVERY group forced false",
    EVENT_GROUPS.every((g) => clientTrackingFlags(offCfg)[g.key] === false),
  );

  console.log("toClientTrackingConfig:");
  const c = toClientTrackingConfig(
    parseTrackingConfig({ "tracking.enabled": "true", "tracking.gtm_id": "GTM-X", "tracking.consent_mode": "basic" }),
  );
  check(
    "client subset (no custom HTML / events)",
    c.enabled === true &&
      c.mode === "basic" &&
      c.gtmId === "GTM-X" &&
      !("customHead" in c) &&
      !("events" in c),
  );
  console.log("bypass + mode off:");
  check("bypass default false", parseTrackingConfig({}).bypassConsent === false);
  check("bypass on", parseTrackingConfig({ "tracking.bypass_consent": "on" }).bypassConsent === true);
  check("mode 'off' parsed", parseTrackingConfig({ "tracking.consent_mode": "off" }).mode === "off");
  check("mode default advanced", parseTrackingConfig({}).mode === "advanced");

  console.log("Consent Mode knobs:");
  check("wait_for_update default 500", parseTrackingConfig({}).waitForUpdate === 500);
  check(
    "wait_for_update clamps to [0,5000]",
    parseTrackingConfig({ "tracking.cm_wait_for_update": "99999" }).waitForUpdate === 5000 &&
      parseTrackingConfig({ "tracking.cm_wait_for_update": "-5" }).waitForUpdate === 0,
  );
  check("ads_data_redaction default true", parseTrackingConfig({}).adsDataRedaction === true);
  check(
    "ads_data_redaction off",
    parseTrackingConfig({ "tracking.cm_ads_data_redaction": "false" }).adsDataRedaction === false,
  );
  check("url_passthrough default true", parseTrackingConfig({}).urlPassthrough === true);

  console.log("per-signal defaults:");
  const sd = parseTrackingConfig({}).signalDefaults;
  check("default: security granted, rest denied", sd.security_storage === "granted" && sd.analytics_storage === "denied");
  check(
    "analytics_storage granted via setting",
    parseTrackingConfig({ "tracking.cm_default_analytics_storage": "granted" }).signalDefaults.analytics_storage === "granted",
  );
  check(
    "security_storage stays granted even if a setting tries to deny it",
    parseTrackingConfig({ "tracking.cm_default_security_storage": "denied" }).signalDefaults.security_storage === "granted",
  );

  console.log(`\n=== done: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main();
