/**
 * Pure Consent Mode v2 helpers — category→signal mapping + the default-consent
 * stub builder. No DB.
 *
 * Run:
 *   pnpm exec tsx --conditions=react-server src/lib/db/tests/tracking-consent-mode.test.ts
 */
import {
  buildConsentDefaultJs,
  signalsFromState,
  deniedSignalDefaults,
  grantedSignalDefaults,
  RESTRICTED_REGIONS,
  type ConsentSignalDefaults,
} from "@/lib/tracking/consent-mode";
import type { ConsentState } from "@/lib/consent/categories";

/** Default build opts so each test overrides only what it asserts. */
function build(over: Partial<{
  defaults: ConsentSignalDefaults;
  forceGranted: boolean;
  regionEeaOnly: boolean;
  waitForUpdate: number;
  adsDataRedaction: boolean;
  urlPassthrough: boolean;
}> = {}): string {
  return buildConsentDefaultJs({
    defaults: deniedSignalDefaults(),
    forceGranted: false,
    regionEeaOnly: true,
    waitForUpdate: 500,
    adsDataRedaction: true,
    urlPassthrough: true,
    ...over,
  });
}

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

const state = (functional: boolean, analytics: boolean, marketing: boolean): ConsentState => ({
  necessary: true,
  functional,
  analytics,
  marketing,
});

function main() {
  console.log("signalsFromState:");
  const granted = signalsFromState(state(true, true, true));
  check(
    "all-granted → every signal granted",
    Object.values(granted).every((v) => v === "granted"),
  );

  const denied = signalsFromState(state(false, false, false));
  check("denied: security_storage always granted", denied.security_storage === "granted");
  check("denied: analytics_storage denied", denied.analytics_storage === "denied");
  check(
    "denied: all ad signals denied",
    denied.ad_storage === "denied" &&
      denied.ad_user_data === "denied" &&
      denied.ad_personalization === "denied",
  );
  check(
    "denied: functionality + personalization denied",
    denied.functionality_storage === "denied" && denied.personalization_storage === "denied",
  );

  const mktOnly = signalsFromState(state(false, false, true));
  check(
    "marketing-only → ad signals granted, analytics denied",
    mktOnly.ad_storage === "granted" &&
      mktOnly.ad_user_data === "granted" &&
      mktOnly.ad_personalization === "granted" &&
      mktOnly.analytics_storage === "denied",
  );
  check(
    "marketing-only → personalization_storage denied (follows functional, not marketing)",
    mktOnly.personalization_storage === "denied" && mktOnly.functionality_storage === "denied",
  );

  const anaOnly = signalsFromState(state(false, true, false));
  check(
    "analytics-only → analytics granted, ad denied",
    anaOnly.analytics_storage === "granted" && anaOnly.ad_storage === "denied",
  );

  const funcOnly = signalsFromState(state(true, false, false));
  check(
    "functional-only → functionality + personalization granted",
    funcOnly.functionality_storage === "granted" &&
      funcOnly.personalization_storage === "granted" &&
      funcOnly.analytics_storage === "denied",
  );
  check(
    "functional-only → ad_personalization denied (follows marketing, not functional)",
    funcOnly.ad_personalization === "denied",
  );

  console.log("signal default helpers:");
  check(
    "deniedSignalDefaults: security granted, rest denied",
    (() => {
      const d = deniedSignalDefaults();
      return d.security_storage === "granted" && d.analytics_storage === "denied" && d.ad_storage === "denied";
    })(),
  );
  check(
    "grantedSignalDefaults: everything granted",
    Object.values(grantedSignalDefaults()).every((v) => v === "granted"),
  );

  console.log("buildConsentDefaultJs:");
  const eea = build({ regionEeaOnly: true });
  check("defines gtag stub", eea.includes("function gtag()") && eea.includes("window.dataLayer"));
  check("calls consent default", eea.includes("gtag('consent','default'"));
  check("default denies analytics", eea.includes('"analytics_storage":"denied"'));
  check("default denies ad_user_data (v2)", eea.includes('"ad_user_data":"denied"'));
  check("default grants security", eea.includes('"security_storage":"granted"'));
  check("wait_for_update present", eea.includes('"wait_for_update":500'));
  check("ads_data_redaction set", eea.includes("ads_data_redaction"));
  check("url_passthrough set", eea.includes("url_passthrough"));
  check(
    "region-scoped includes every restricted region",
    RESTRICTED_REGIONS.every((r) => eea.includes(`"${r}"`)),
  );
  check(
    "region scope covers real EEA countries (FR/DE/ES) + GB + TN",
    ["FR", "DE", "ES", "GB", "TN"].every((r) => eea.includes(`"${r}"`)),
  );
  check(
    "region scope drops the invalid 'EU'/'EEA' pseudo-codes",
    !eea.includes('"EU"') && !eea.includes('"EEA"'),
  );

  const global = build({ regionEeaOnly: false });
  check("global mode has no region key", !global.includes('"region"'));
  check("global mode still denies analytics", global.includes('"analytics_storage":"denied"'));
  const gm = global.match(/gtag\('consent','default',(\{.*?\})\);/);
  check(
    "global default parses: wait_for_update 500, analytics denied, no region key",
    Boolean(gm) &&
      (() => {
        try {
          const o = JSON.parse(gm![1]) as Record<string, unknown>;
          return o.wait_for_update === 500 && o.analytics_storage === "denied" && !("region" in o);
        } catch {
          return false;
        }
      })(),
  );

  console.log("forceGranted (bypass / banner-disabled):");
  const forced = build({ forceGranted: true, regionEeaOnly: true });
  check("forceGranted: analytics granted", forced.includes('"analytics_storage":"granted"'));
  check("forceGranted: ad_storage granted", forced.includes('"ad_storage":"granted"'));
  check("forceGranted: no region scoping (collect everywhere)", !forced.includes('"region"'));

  console.log("per-signal defaults + flag toggles:");
  const optOut = build({
    defaults: { ...deniedSignalDefaults(), analytics_storage: "granted" },
  });
  check(
    "per-signal: analytics granted by default, ad still denied",
    optOut.includes('"analytics_storage":"granted"') && optOut.includes('"ad_storage":"denied"'),
  );
  const noFlags = build({ adsDataRedaction: false, urlPassthrough: false, waitForUpdate: 1000 });
  check("ads_data_redaction omitted when off", !noFlags.includes("ads_data_redaction"));
  check("url_passthrough omitted when off", !noFlags.includes("url_passthrough"));
  check("custom wait_for_update respected", noFlags.includes('"wait_for_update":1000'));

  // The serialized default object must be valid JSON (injection-safe).
  const m = eea.match(/gtag\('consent','default',(\{.*?\})\);/);
  check("default object is parseable JSON", Boolean(m) && (() => {
    try {
      JSON.parse(m![1]);
      return true;
    } catch {
      return false;
    }
  })());

  console.log(`\n=== done: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main();
