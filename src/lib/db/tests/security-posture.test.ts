/**
 * Pure security-posture model (src/lib/security/posture.ts). No DB, no server-only.
 *
 * Run:
 *   pnpm exec tsx --conditions=react-server src/lib/db/tests/security-posture.test.ts
 */
import { computePosture, type PostureFacts } from "@/lib/security/posture";

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

/** A fully-hardened baseline (everything passing, no info). */
const STRONG: PostureFacts = {
  isProd: true,
  authSecretValid: true,
  paymentEncryptionConfigured: true,
  // Hardened = the key is supplied out-of-band (env), NOT auto-generated into the DB.
  paymentKeyFromDb: false,
  dbTlsVerified: true,
  cspHasNonce: true,
  cspStrictDirectives: true,
  hsts: true,
  twoFactorAvailable: true,
  twoFactorDataAvailable: true,
  adminsWithout2fa: 0,
  bruteForceThrottling: true,
  lastAdminFloor: true,
  securityEventLogging: true,
  emailVerificationRequired: true,
  mailDelivers: true,
};

const byId = (items: ReturnType<typeof computePosture>["items"], id: string) =>
  items.find((i) => i.id === id);

function main() {
  console.log("computePosture — fully hardened:");
  const strong = computePosture(STRONG);
  check("no warnings", strong.summary.warn === 0);
  check("score 100", strong.summary.scorePct === 100);
  check("all scoreable pass", strong.summary.pass === strong.summary.total);
  check("every item has an OWASP tag", strong.items.every((i) => /^A\d/.test(i.owasp)));
  check("stable item count", strong.items.length === 12);

  console.log("computePosture — current real state (csp nonce pending):");
  const current = computePosture({ ...STRONG, cspHasNonce: false });
  check("csp-nonce → warn", byId(current.items, "csp-nonce")?.status === "warn");
  check("exactly one warning", current.summary.warn === 1);
  check("score < 100 but high", current.summary.scorePct > 80 && current.summary.scorePct < 100);

  console.log("computePosture — DB TLS is info when not required (neutral to score):");
  const noTls = computePosture({ ...STRONG, cspHasNonce: false, dbTlsVerified: null });
  check("db-tls → info", byId(noTls.items, "db-tls")?.status === "info");
  check("info counted in summary", noTls.summary.info === 1);
  // db-tls moves from pass→info, so it leaves BOTH numerator + denominator: with
  // one remaining warn (csp-nonce) the score is 9/10 = 90 (vs current's 10/11=91).
  check("info neutral: still scored on the rest", noTls.summary.scorePct === 91);
  check("an all-info-or-pass set scores 100", computePosture({ ...STRONG, dbTlsVerified: null }).summary.scorePct === 100);

  console.log("computePosture — DB TLS required-but-unverified → warn:");
  const badTls = computePosture({ ...STRONG, dbTlsVerified: false });
  check("db-tls → warn", byId(badTls.items, "db-tls")?.status === "warn");

  console.log("computePosture — admins without 2FA → warn with the count:");
  const no2fa = computePosture({ ...STRONG, adminsWithout2fa: 3 });
  check("2fa → warn", byId(no2fa.items, "2fa")?.status === "warn");
  check("2fa detail names the count", (byId(no2fa.items, "2fa")?.detail ?? "").includes("3"));

  console.log("computePosture — weak secret + no payment enc + no logging:");
  const weak = computePosture({
    ...STRONG,
    authSecretValid: false,
    paymentEncryptionConfigured: false,
    securityEventLogging: false,
    cspHasNonce: false,
  });
  check("auth-secret → warn", byId(weak.items, "auth-secret")?.status === "warn");
  check("payment-enc → warn", byId(weak.items, "payment-enc")?.status === "warn");
  check("sec-logging → warn", byId(weak.items, "sec-logging")?.status === "warn");
  check("score reflects multiple gaps", weak.summary.warn >= 4 && weak.summary.scorePct < 70);

  console.log("computePosture — payment key present but co-located in the DB → warn (not a blind pass):");
  const keyInDb = computePosture({ ...STRONG, paymentKeyFromDb: true });
  check("payment-enc → warn when key auto-generated into app_secrets", byId(keyInDb.items, "payment-enc")?.status === "warn");
  check("payment-enc detail explains the co-location gap", /base|dump|environnement/i.test(byId(keyInDb.items, "payment-enc")?.detail ?? ""));
  check("a co-located key costs score vs a true env pass", keyInDb.summary.scorePct < 100);
  check("an env-supplied key (STRONG) still scores a clean payment-enc pass", byId(strong.items, "payment-enc")?.status === "pass");

  console.log("computePosture — email verification off → info (not a hard fail):");
  const noVerif = computePosture({ ...STRONG, emailVerificationRequired: false });
  check("email-verif → info", byId(noVerif.items, "email-verif")?.status === "info");

  console.log("computePosture — console mail provider delivers nothing → warn in prod:");
  check(
    "mail-delivery passes with a real provider",
    byId(computePosture(STRONG).items, "mail-delivery")?.status === "pass",
  );
  check(
    "mail-delivery warns in prod when provider is console",
    byId(computePosture({ ...STRONG, isProd: true, mailDelivers: false }).items, "mail-delivery")?.status === "warn",
  );

  console.log("computePosture — 2FA adoption unknown (signals degraded) → info, not false-pass:");
  const degraded = computePosture({ ...STRONG, twoFactorDataAvailable: false });
  check("2fa → info when data unavailable", byId(degraded.items, "2fa")?.status === "info");
  check("2fa info excluded from score (still 100 on the rest)", degraded.summary.scorePct === 100);
  const degradedGap = computePosture({ ...STRONG, twoFactorDataAvailable: false, adminsWithout2fa: 5 });
  check("2fa stays info even if a stale count leaks through", byId(degradedGap.items, "2fa")?.status === "info");

  console.log("computePosture — each boolean control flips pass→warn on its own fact:");
  check("hsts:false → warn", byId(computePosture({ ...STRONG, hsts: false }).items, "hsts")?.status === "warn");
  check("cspStrictDirectives:false → csp-strict warn", byId(computePosture({ ...STRONG, cspStrictDirectives: false }).items, "csp-strict")?.status === "warn");
  check("bruteForceThrottling:false → brute-force warn", byId(computePosture({ ...STRONG, bruteForceThrottling: false }).items, "brute-force")?.status === "warn");
  check("lastAdminFloor:false → last-admin warn", byId(computePosture({ ...STRONG, lastAdminFloor: false }).items, "last-admin")?.status === "warn");
  check("securityEventLogging:false → sec-logging warn", byId(computePosture({ ...STRONG, securityEventLogging: false }).items, "sec-logging")?.status === "warn");
  check("twoFactorAvailable:false → 2fa warn", byId(computePosture({ ...STRONG, twoFactorAvailable: false }).items, "2fa")?.status === "warn");

  console.log(`\n=== done: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main();
