/**
 * Pure effective-consent resolver (src/lib/consent/effective.ts) — the
 * harmonization of the Cookies & RGPD config with the Suivi bypass switch — plus
 * the consent-REVISION rule shared by the provider, hasConsent() (the funnel) and
 * /api/track (src/lib/consent/state.ts): a decision recorded before the admin
 * bumped `consent.revision` is void. No DB (hasConsent reads a stubbed
 * `document.cookie`).
 *
 * Run:
 *   pnpm exec tsx --conditions=react-server src/lib/db/tests/consent-effective.test.ts
 */
import {
  maskByOffer,
  resolveEffectiveConsent,
  isForceGranted,
  type ConsentOffer,
} from "@/lib/consent/effective";
import {
  CONSENT_COOKIE,
  grantedState,
  deniedState,
  type ConsentRecord,
  type ConsentState,
} from "@/lib/consent/categories";
import {
  hasConsent,
  isConsentRecordCurrent,
  setConsentRevision,
} from "@/lib/consent/state";

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

const ALL_OFFER: ConsentOffer = { functional: true, analytics: true, marketing: true };
const NO_MARKETING: ConsentOffer = { functional: true, analytics: true, marketing: false };
const state = (f: boolean, a: boolean, m: boolean): ConsentState => ({
  necessary: true,
  functional: f,
  analytics: a,
  marketing: m,
});

function main() {
  console.log("maskByOffer:");
  check(
    "drops a granted category the admin no longer offers",
    (() => {
      const masked = maskByOffer(state(true, true, true), NO_MARKETING);
      return masked.marketing === false && masked.analytics === true && masked.functional === true;
    })(),
  );
  check("necessary always true", maskByOffer(deniedState(), ALL_OFFER).necessary === true);
  check(
    "never grants beyond the decision",
    maskByOffer(state(false, false, false), ALL_OFFER).analytics === false,
  );

  console.log("resolveEffectiveConsent — bypass:");
  const bypass = resolveEffectiveConsent({
    bannerEnabled: true,
    bypass: true,
    offer: NO_MARKETING,
    decided: false,
    decision: deniedState(),
  });
  check("bypass → posture bypass", bypass.posture === "bypass");
  check("bypass → all granted (ignores offer + decision)", JSON.stringify(bypass.state) === JSON.stringify(grantedState()));
  check("bypass → decided true", bypass.decided === true);

  console.log("resolveEffectiveConsent — disabled banner:");
  const disabled = resolveEffectiveConsent({
    bannerEnabled: false,
    bypass: false,
    offer: ALL_OFFER,
    decided: false,
    decision: deniedState(),
  });
  check("banner off → posture disabled", disabled.posture === "disabled");
  check("banner off → all granted", JSON.stringify(disabled.state) === JSON.stringify(grantedState()));

  console.log("resolveEffectiveConsent — managed:");
  const undecided = resolveEffectiveConsent({
    bannerEnabled: true,
    bypass: false,
    offer: ALL_OFFER,
    decided: false,
    decision: deniedState(),
  });
  check("managed + undecided → denied + not decided", undecided.posture === "managed" && undecided.decided === false && undecided.state.analytics === false);

  const decided = resolveEffectiveConsent({
    bannerEnabled: true,
    bypass: false,
    offer: NO_MARKETING,
    decided: true,
    decision: state(true, true, true),
  });
  check(
    "managed + decided → masked by offer (stale marketing grant revoked)",
    decided.posture === "managed" &&
      decided.decided === true &&
      decided.state.marketing === false &&
      decided.state.analytics === true,
  );

  console.log("isForceGranted:");
  check("bypass → force granted", isForceGranted("bypass") === true);
  check("disabled → force granted", isForceGranted("disabled") === true);
  check("managed → not force granted", isForceGranted("managed") === false);

  console.log("isConsentRecordCurrent (revision bump voids earlier decisions):");
  const rec = (v: unknown) => ({ v, t: 0, categories: grantedState() });
  check("same revision → current", isConsentRecordCurrent(rec(2), 2) === true);
  check("newer revision → current", isConsentRecordCurrent(rec(3), 2) === true);
  check("older revision → void", isConsentRecordCurrent(rec(1), 2) === false);
  check("no record → void", isConsentRecordCurrent(null, 1) === false);
  check("non-numeric v → void", isConsentRecordCurrent(rec("2"), 1) === false);
  check("missing v → void", isConsentRecordCurrent({}, 1) === false);

  console.log("hasConsent honours the mirrored revision (funnel parity with the provider):");
  const g = globalThis as { document?: { cookie: string } };
  const hadDocument = "document" in g;
  const prevDocument = g.document;
  const writeCookie = (r: ConsentRecord) => {
    g.document = { cookie: `${CONSENT_COOKIE}=${encodeURIComponent(JSON.stringify(r))}` };
  };
  try {
    // A returning visitor who granted everything under revision 1.
    writeCookie({ v: 1, t: 0, categories: grantedState() });
    setConsentRevision(1);
    check("rev 1 grant under rev 1 → analytics granted", hasConsent("analytics") === true);
    check("rev 1 grant under rev 1 → marketing granted", hasConsent("marketing") === true);
    // Admin bumps the revision → the old grant no longer counts until re-answer.
    setConsentRevision(2);
    check("rev 1 grant after bump to 2 → analytics denied", hasConsent("analytics") === false);
    check("rev 1 grant after bump to 2 → marketing denied", hasConsent("marketing") === false);
    check("necessary stays granted after a bump", hasConsent("necessary") === true);
    // The visitor re-answers under revision 2.
    writeCookie({ v: 2, t: 1, categories: state(false, true, false) });
    check("re-answered under rev 2 → analytics granted", hasConsent("analytics") === true);
    check("re-answered under rev 2 → marketing denied (their new choice)", hasConsent("marketing") === false);
  } finally {
    setConsentRevision(1);
    if (hadDocument) g.document = prevDocument;
    else delete g.document;
  }

  console.log(`\n=== done: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main();
