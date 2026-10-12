/**
 * Auth-policy invariants — PURE (policy.ts has no DB/server deps). Guards the
 * rate-limit rules + session-policy bounds that the security model + the admin
 * session panel depend on, the effective-session-policy resolver the Sécurité
 * tab displays (session-policy.ts), and the OAuth error round-trip to /login
 * (oauth-errors.ts). No DB.
 *
 * Run:
 *   pnpm exec tsx --conditions=react-server src/lib/db/tests/auth-policy.test.ts
 */
import {
  AUTH_HTTP_DISABLED_PATHS,
  AUTH_RATE_LIMITS,
  SESSION_POLICY_BOUNDS,
  SESSION_POLICY_KEYS,
  oauthAutolinkGate,
  isOAuthCallbackPath,
} from "@/lib/auth/policy";
import { resolveSessionPolicyFromSettings } from "@/lib/auth/session-policy";
import { oauthErrorCallbackURL, oauthErrorMessage } from "@/lib/auth/oauth-errors";

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.log(`  ✗ ${label}`);
  }
}

function main() {
  const rules = AUTH_RATE_LIMITS.rules as Record<string, { window: number; max: number }>;

  // Sensitive endpoints have an explicit (stricter-than-default) HTTP rule.
  for (const ep of [
    "/sign-in/email",
    "/two-factor/verify-totp",
    "/two-factor/verify-backup-code",
  ]) {
    check(`rule present for ${ep}`, !!rules[ep]);
    check(`${ep} cap is stricter than the global default`, !!rules[ep] && rules[ep].max < AUTH_RATE_LIMITS.maxPerWindow);
  }

  // 2FA endpoints with no app caller are 404 over HTTP: get-totp-uri is a
  // password oracle that also returns the TOTP secret; the email-OTP pair is
  // unused. The three the /account card calls stay reachable.
  const disabled = new Set<string>(AUTH_HTTP_DISABLED_PATHS);
  for (const ep of [
    "/two-factor/get-totp-uri",
    "/two-factor/send-otp",
    "/two-factor/verify-otp",
    "/two-factor/verify-backup-code",
    "/two-factor/generate-backup-codes",
    "/verify-password",
  ]) {
    check(`${ep} is disabled over HTTP`, disabled.has(ep));
  }
  for (const ep of ["/two-factor/enable", "/two-factor/verify-totp", "/two-factor/disable", "/get-session"]) {
    check(`${ep} stays reachable (authClient caller)`, !disabled.has(ep));
  }

  // Session-policy bounds are coherent: min ≤ def ≤ max for each.
  for (const [k, b] of Object.entries(SESSION_POLICY_BOUNDS)) {
    check(`${k}: min ≤ def ≤ max`, b.min <= b.def && b.def <= b.max);
  }
  // Cookie-cache can be disabled (0); lifetime/refresh can't be 0.
  check("cookieCacheMinutes can be disabled (min 0)", SESSION_POLICY_BOUNDS.cookieCacheMinutes.min === 0);
  // Ceiling capped so a stolen-cookie / force-logout window can't be stretched to
  // hours (max ≤ 30 min); see the SECURITY note in policy.ts.
  check("cookieCacheMinutes max ≤ 30", SESSION_POLICY_BOUNDS.cookieCacheMinutes.max <= 30);
  check("expiresDays min ≥ 1", SESSION_POLICY_BOUNDS.expiresDays.min >= 1);

  // Keys are namespaced under auth.session.*
  for (const key of Object.values(SESSION_POLICY_KEYS)) {
    check(`key ${key} is namespaced`, key.startsWith("auth.session."));
  }

  // Effective session policy (Sécurité → Authentification) — same clamp as
  // resolveSessionPolicy in server.ts: in-range values win, anything else falls
  // back to the AUTH_POLICY default (never clamped to the nearest bound).
  const K = SESSION_POLICY_KEYS;
  const B = SESSION_POLICY_BOUNDS;
  const defaults = resolveSessionPolicyFromSettings({});
  check(
    "no settings → AUTH_POLICY defaults",
    defaults.expiresDays === B.expiresDays.def &&
      defaults.updateAgeDays === B.updateAgeDays.def &&
      defaults.cookieCacheMinutes === B.cookieCacheMinutes.def,
  );
  const tuned = resolveSessionPolicyFromSettings({
    [K.expiresDays]: "90",
    [K.updateAgeDays]: "3",
    [K.cookieCacheMinutes]: "30",
  });
  check(
    "admin-tuned in-range values are the effective ones (not the defaults)",
    tuned.expiresDays === 90 && tuned.updateAgeDays === 3 && tuned.cookieCacheMinutes === 30,
  );
  check(
    "cookieCacheMinutes 0 (cache disabled) is honoured",
    resolveSessionPolicyFromSettings({ [K.cookieCacheMinutes]: "0" }).cookieCacheMinutes === 0,
  );
  const outOfRange = resolveSessionPolicyFromSettings({
    [K.expiresDays]: String(B.expiresDays.max + 1),
    [K.updateAgeDays]: "0",
    [K.cookieCacheMinutes]: String(B.cookieCacheMinutes.max + 1),
  });
  check(
    "out-of-range values fall back to the defaults (not clamped)",
    outOfRange.expiresDays === B.expiresDays.def &&
      outOfRange.updateAgeDays === B.updateAgeDays.def &&
      outOfRange.cookieCacheMinutes === B.cookieCacheMinutes.def,
  );
  check(
    "garbage value falls back to the default",
    resolveSessionPolicyFromSettings({ [K.expiresDays]: "abc" }).expiresDays === B.expiresDays.def,
  );
  check(
    "fractional value is rounded",
    resolveSessionPolicyFromSettings({ [K.expiresDays]: "13.6" }).expiresDays === 14,
  );

  // OAuth error round-trip: the errorCallbackURL must pass Better Auth's
  // relative-path allow-list (better-auth dist/auth/trusted-origins.mjs) or the
  // whole social sign-in is refused (INVALID_ERROR_CALLBACK_URL) — mirror it.
  const baRelative = /^\/(?!\/|\\|%2f|%5c)[\w\-.+/@]*(?:\?[\w\-.+/=&%@]*)?$/;
  check("default destination → plain /login", oauthErrorCallbackURL("/account") === "/login");
  check(
    "destination kept as ?from=",
    oauthErrorCallbackURL("/checkout") === "/login?from=%2Fcheckout",
  );
  for (const dest of ["/account", "/checkout", "/checkout?step=2&x=1", "/pro/espace", "/a(b)!~", ""]) {
    const url = oauthErrorCallbackURL(dest);
    check(`errorCallbackURL for ${JSON.stringify(dest)} passes BA's allow-list (${url})`, baRelative.test(url));
  }
  check("no ?error= → no message", oauthErrorMessage(null) === null && oauthErrorMessage("") === null);
  check(
    "unable_to_link_account points to the profile autolink toggle",
    (oauthErrorMessage("unable_to_link_account") ?? "").includes("Connexion Google automatique"),
  );
  check(
    "ACCOUNT_DISABLED → disabled-account copy",
    (oauthErrorMessage("ACCOUNT_DISABLED") ?? "").includes("désactivé"),
  );
  check("unknown code → generic French message", !!oauthErrorMessage("something_else"));
  check(
    "two_factor_required → 2FA copy (social sign-in blocked for a 2FA account)",
    (oauthErrorMessage("two_factor_required") ?? "").includes("double authentification"),
  );

  // ── OAuth account-linking gate (oauthAutolinkGate) — the security-critical
  // decision behind account.create.before. These assertions are the regression
  // guard: dropping the 2FA branch (the 2FA-bypass-via-social-link block) flips a
  // check red instead of silently re-opening the vector.
  check(
    "credential account → always allow (not a social merge)",
    oauthAutolinkGate({ providerId: "credential", hasPasswordAccount: true, twoFactorEnabled: true, oauthAutolink: false }) === "allow",
  );
  check(
    "OAuth onto a user with NO password account → allow (fresh social sign-up)",
    oauthAutolinkGate({ providerId: "google", hasPasswordAccount: false, twoFactorEnabled: false, oauthAutolink: false }) === "allow",
  );
  check(
    "OAuth onto a password account with 2FA → BLOCK even when oauthAutolink is ON (2FA never bypassed)",
    oauthAutolinkGate({ providerId: "google", hasPasswordAccount: true, twoFactorEnabled: true, oauthAutolink: true }) === "block",
  );
  check(
    "OAuth onto a non-2FA password account with oauthAutolink ON → allow (the 0157 default)",
    oauthAutolinkGate({ providerId: "google", hasPasswordAccount: true, twoFactorEnabled: false, oauthAutolink: true }) === "allow",
  );
  check(
    "OAuth onto a non-2FA password account with oauthAutolink OFF → block (fail-closed opt-out)",
    oauthAutolinkGate({ providerId: "google", hasPasswordAccount: true, twoFactorEnabled: false, oauthAutolink: false }) === "block",
  );

  // ── isOAuthCallbackPath — scopes the session-mint enforcement (2FA-on-social
  // block + disabled-user redirect) to the OAuth callback, NOT the credential
  // /two-factor/verify-totp path (which legitimately mints a 2FA session).
  check("callback path matches", isOAuthCallbackPath("/callback/google") && isOAuthCallbackPath("/callback/facebook"));
  check(
    "non-callback paths do NOT match",
    !isOAuthCallbackPath("/two-factor/verify-totp") &&
      !isOAuthCallbackPath("/sign-in/social") &&
      !isOAuthCallbackPath("/verify-email") &&
      !isOAuthCallbackPath(undefined) &&
      !isOAuthCallbackPath(null),
  );

  console.log(`\n=== done: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main();
