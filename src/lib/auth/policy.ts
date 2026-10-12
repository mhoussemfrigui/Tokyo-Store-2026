/**
 * Auth policy constants — PURE (no `server-only`, no better-auth import), so the
 * Security diagnostics tab can import them WITHOUT pulling in the auth instance.
 * The better-auth config (src/lib/auth/server.ts) builds itself from these, so
 * the displayed policy can never drift from what's actually enforced.
 */

export const AUTH_POLICY = {
  minPasswordLength: 12,
  maxPasswordLength: 128,
  requireEmailVerification: true,
  emailVerificationExpiresHours: 24,
  passwordResetExpiresMinutes: 60,
  sessionExpiresDays: 7,
  sessionUpdateAgeDays: 1,
  // 5 min default is a deliberate balance: the gated paths (requireSession /
  // requirePermission) re-read the user row live, so a *disable* (and any
  // role/permission change) is enforced immediately regardless of this cache —
  // the window only delays revocation of a stolen cookie for a NON-disabled user
  // that was force-logged-out by session deletion alone. The admin ceiling is
  // capped at 30 min (SESSION_POLICY_BOUNDS) so a misconfigured store can't
  // stretch that stolen-cookie window to hours; the admin save action clamps to
  // that ceiling before persisting, and resolveSessionPolicy independently
  // IGNORES any out-of-range saved value and falls back to this default (which
  // is inside bounds) — so the enforced cache window can never exceed 30 min.
  sessionCookieCacheMinutes: 5,
  cookiePrefix: "gz",
  cookieSameSite: "lax",
  cookieHttpOnly: true,
  /** OAuth providers Better Auth will ATTEMPT to auto-link onto an existing
   *  account (others only ever create their own new account — Facebook never
   *  auto-links). NOTE: the attempt is then GATED per-user by the
   *  `account.create.before` hook (src/lib/auth/server.ts): as of migration 0157
   *  `users.oauth_autolink` defaults ON, so a silent link onto an existing
   *  email/password account is ALLOWED by default — EXCEPT an account with 2FA
   *  enabled, which is ALWAYS blocked (a second factor is never bypassed by a
   *  social callback), and an account whose owner explicitly turned the toggle
   *  OFF. See `oauthAutolinkGate` below (the single, testable decision). */
  trustedLinkingProviders: ["google"],
} as const;

/**
 * OAuth account-linking gate decision — a PURE mirror of the
 * `databaseHooks.account.create.before` logic in server.ts, extracted so the
 * security-critical branches are unit-testable: a future refactor that drops the
 * 2FA branch fails a test rather than silently re-opening the 2FA-bypass-via-
 * social-link vector. Semantics:
 *   - `credential` (email/password) account → never gated ("allow").
 *   - OAuth account onto a user with NO password account → a fresh social
 *     sign-up, not a merge ("allow").
 *   - OAuth account onto a user that HAS a password account (a real link/merge):
 *       • 2FA enabled → ALWAYS "block" (regardless of the toggle);
 *       • else "allow" iff `oauthAutolink` (default TRUE since migration 0157).
 */
export function oauthAutolinkGate(input: {
  providerId: string;
  hasPasswordAccount: boolean;
  twoFactorEnabled: boolean;
  oauthAutolink: boolean;
}): "allow" | "block" {
  if (input.providerId === "credential") return "allow";
  if (!input.hasPasswordAccount) return "allow";
  if (input.twoFactorEnabled) return "block";
  return input.oauthAutolink ? "allow" : "block";
}

/**
 * True when a Better Auth request-context path is the OAuth provider callback
 * (`/callback/<provider>`). PURE, so the session-mint enforcement it scopes (the
 * 2FA-on-social block + the disabled-user redirect in server.ts
 * `session.create.before`) is unit-testable. The credential 2FA path creates its
 * session at `/two-factor/verify-totp` (after TOTP), which must NOT be blocked —
 * hence the callback-only scope.
 */
export function isOAuthCallbackPath(path: string | null | undefined): boolean {
  return typeof path === "string" && path.startsWith("/callback/");
}

/**
 * Admin-tunable session-policy bounds (Système → Utilisateurs → Sessions). The
 * `AUTH_POLICY` values above are the DEFAULTS; the admin can override each within
 * [min, max] from `site_settings` (read in `buildAuth` via `resolveSessionPolicy`).
 * Pure constants so the admin panel can render the min/max hints client-side.
 *
 * `cookieCacheMinutes` min 0 ⇒ "disable the cache" (always re-read the session
 * row). Higher = fewer DB reads but a longer force-logout latency (disable stays
 * the immediate kill switch since the gates re-fetch the user row live).
 */
export const SESSION_POLICY_BOUNDS = {
  expiresDays: { def: AUTH_POLICY.sessionExpiresDays, min: 1, max: 90 },
  updateAgeDays: { def: AUTH_POLICY.sessionUpdateAgeDays, min: 1, max: 60 },
  cookieCacheMinutes: { def: AUTH_POLICY.sessionCookieCacheMinutes, min: 0, max: 30 },
} as const;

/** Settings keys the session policy is stored under. */
export const SESSION_POLICY_KEYS = {
  expiresDays: "auth.session.expires_days",
  updateAgeDays: "auth.session.update_age_days",
  cookieCacheMinutes: "auth.session.cookie_cache_minutes",
} as const;

/**
 * Admin toggle: is email verification OBLIGATOIRE before an email/password user
 * can log in? `AUTH_POLICY.requireEmailVerification` (true) is the default — only
 * the literal string "false" in `site_settings` disables it. Read in `buildAuth`
 * (resolveSessionPolicy) and surfaced read-only on the Sécurité diagnostics tab,
 * so the displayed policy never drifts from what's enforced. Turning it OFF only
 * stops BLOCKING unverified logins; the verification email is still sent on
 * signup (emailVerification.sendOnSignUp), so users can still verify later.
 */
export const EMAIL_VERIFICATION_REQUIRED_KEY = "auth.email_verification_required";

/**
 * Better Auth endpoints DISABLED over HTTP (`disabledPaths` in buildAuth → 404
 * from /api/auth/*). Each is served IN-PROCESS by a server action / workflow
 * that adds what the raw endpoint lacks — Postgres per-IP + per-account/per-email
 * throttles, audit events (user.sign_in_failed, auth.rate_limited…), the signup
 * invariants (customer profile + link + user.created). Better Auth checks this
 * list only in its HTTP router, so the in-process `auth.api.*` calls keep working.
 *
 * MUST stay reachable (NOT listed): /get-session + /two-factor/{enable,
 * verify-totp,disable} (authClient: /account 2FA card — the only 2FA calls the
 * app makes; their audit + the enable-while-on guard are Better Auth hooks in
 * buildAuth), /sign-in/social + /callback/* (OAuth), /verify-email + GET
 * /reset-password/:token (emailed links), /sign-out.
 */
export const AUTH_HTTP_DISABLED_PATHS = [
  "/sign-in/email",
  "/sign-up/email",
  "/request-password-reset",
  "/reset-password",
  "/send-verification-email",
  "/change-password",
  "/change-email",
  "/update-user",
  "/delete-user",
  "/verify-password",
  // Backup codes: verified by verifyTwoFactorAction (per-challenge cap) and
  // generated only at enrolment (twoFactor.enable) — no HTTP caller.
  "/two-factor/verify-backup-code",
  "/two-factor/generate-backup-codes",
  // No app caller (the enrolment QR comes from twoFactor.enable's URI via
  // twoFactorQrAction). get-totp-uri is a password oracle on the 30/min default
  // limit that ALSO returns the TOTP secret (clone the authenticator from a
  // stolen session); the email-OTP pair is unused (no sendOTP configured).
  "/two-factor/get-totp-uri",
  "/two-factor/send-otp",
  "/two-factor/verify-otp",
] as const;

/**
 * better-auth rate-limit policy (per IP, per endpoint). The default applies to
 * every `/api/auth/*` route; `rules` override specific sensitive endpoints.
 * Rules for an AUTH_HTTP_DISABLED_PATHS entry are defence-in-depth only (the
 * path 404s before the limiter runs).
 */
export const AUTH_RATE_LIMITS = {
  windowSeconds: 60,
  maxPerWindow: 30,
  rules: {
    "/sign-in/email": { window: 60, max: 5 },
    "/sign-up/email": { window: 60, max: 3 },
    "/reset-password": { window: 60, max: 5 },
    "/verify-email": { window: 60, max: 10 },
    // 2FA verify endpoints — a 6-digit TOTP / backup code must not be
    // brute-forceable. NOTE: the PRIMARY login + /login/2fa flows call
    // `auth.api.*` IN-PROCESS, which bypasses this HTTP limiter — those paths
    // are throttled explicitly with `checkRateLimit` (signinAction +
    // verifyTwoFactorAction). These rules harden any direct HTTP hit; a direct
    // HTTP verify-totp also shares verifyTwoFactorAction's Postgres per-challenge
    // bucket (hooks.before in buildAuth).
    "/two-factor/verify-totp": { window: 60, max: 5 },
    "/two-factor/verify-backup-code": { window: 60, max: 5 },
    "/two-factor/enable": { window: 60, max: 5 },
    "/two-factor/disable": { window: 60, max: 5 },
  },
} as const;
