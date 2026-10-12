import "server-only";

import { serverEnv } from "@/lib/env";
import { oauthSettingsService } from "@/modules/oauth";
import { decryptSecret } from "@/lib/crypto/secrets";
import { getSettingsMap } from "@/modules/cms/setting/queries";

/**
 * ── SOCIAL LOGIN MODULE — single source of truth ─────────────────────────
 * This file IS the social-login (OAuth) module's credential resolver. The end-
 * to-end chain is admin-driven, with NO hardcoded credentials anywhere:
 *
 *   1. Admin settings (Clients → Connexion & comptes): per-provider
 *      `auth.social.<provider>_enabled` toggle + encrypted client id/secret,
 *      OR the matching `*_CLIENT_ID` / `*_CLIENT_SECRET` env vars.
 *   2. `resolveSocialCredentials()` (here) — env wins when set, else the
 *      decrypted DB value; a provider is "ready" only when BOTH resolve.
 *   3. `buildAuth` (lib/auth/server.ts) feeds the resolved creds into
 *      better-auth `socialProviders`.
 *   4. `getAuthPagesConfig` (lib/auth/pages-config.ts) combines the readiness
 *      (here, via `socialProvidersReady`) with the admin toggle → `social.*`.
 *   5. `<SocialAuthButtons>` (components/auth/social-buttons.tsx) renders the
 *      "Continuer avec Google/Facebook" button ONLY when that flag is true.
 *      Mounted on /login, /register, /pro/login AND the checkout account-choice
 *      block (checkout-account.tsx) — every entry point reuses ONE button.
 *
 * To add a provider: add its env vars + admin settings, extend the resolver +
 * the toggle here, then pass the new flag to `<SocialAuthButtons>`.
 *
 * Resolve live social-login (OAuth) credentials with ENV-FORCED-OVERRIDE
 * precedence, mirroring `resolvePaymentConfig` (src/lib/payments/config.ts):
 *
 *   value = (env var, when actually set)  ??  (decrypted DB value)  ??  ""
 *
 * A blank/whitespace env var counts as UNSET (Coolify delivers empty dashboard
 * fields as ""), so it falls through to the admin-saved DB value rather than
 * blanking a working credential.
 *
 * A provider is "ready" only when BOTH its client id and secret resolve to a
 * non-empty value. The admin toggle (`auth.social.<provider>_enabled`) then
 * gates whether the storefront SHOWS the button — see pages-config.ts.
 *
 * Cached for a short TTL: the login/register pages hit this on every render to
 * decide button visibility, and `buildAuth` reads it once per instance build.
 * The admin save action calls `invalidateSocialConfigCache()` (and rebuilds the
 * auth instance) so changes apply within seconds regardless.
 *
 * Never throws — a DB read failure resolves to env-only (or all-empty), so the
 * auth instance and the auth pages always build.
 */

export type SocialProviderCreds = { clientId: string; clientSecret: string };

export type ResolvedSocialCreds = {
  google: SocialProviderCreds | null;
  facebook: SocialProviderCreds | null;
};

const TTL_MS = 30_000;
let cache: { value: ResolvedSocialCreds; expires: number } | null = null;

function envStr(v: string | undefined): string | undefined {
  const t = v?.trim();
  return t ? t : undefined;
}

/** ENV wins when set; else decrypted DB ciphertext; else "". */
function pick(env: string | undefined, enc: string | null | undefined): string {
  return envStr(env) ?? decryptSecret(enc);
}

function readyOrNull(clientId: string, clientSecret: string): SocialProviderCreds | null {
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

export function invalidateSocialConfigCache(): void {
  cache = null;
}

/**
 * Whether a given field is force-locked by the environment — the admin panel
 * disables the matching input and shows an "env" badge (env value wins).
 */
export function socialEnvLock(provider: "google" | "facebook"): {
  id: boolean;
  secret: boolean;
} {
  if (provider === "google") {
    return {
      id: Boolean(envStr(serverEnv.GOOGLE_CLIENT_ID)),
      secret: Boolean(envStr(serverEnv.GOOGLE_CLIENT_SECRET)),
    };
  }
  return {
    id: Boolean(envStr(serverEnv.FACEBOOK_CLIENT_ID)),
    secret: Boolean(envStr(serverEnv.FACEBOOK_CLIENT_SECRET)),
  };
}

export async function resolveSocialCredentials(): Promise<ResolvedSocialCreds> {
  const now = Date.now();
  if (cache && cache.expires > now) return cache.value;

  // One SELECT over the tiny provider table (≤2 rows), not two PK lookups — this
  // runs on every login/register render (cache miss) + each auth-instance build.
  const rows = await oauthSettingsService.listAll().catch(() => []);
  const byProvider = new Map(rows.map((r) => [r.provider, r]));
  const googleRow = byProvider.get("google") ?? null;
  const facebookRow = byProvider.get("facebook") ?? null;

  const value: ResolvedSocialCreds = {
    google: readyOrNull(
      pick(serverEnv.GOOGLE_CLIENT_ID, googleRow?.client_id_enc),
      pick(serverEnv.GOOGLE_CLIENT_SECRET, googleRow?.client_secret_enc),
    ),
    facebook: readyOrNull(
      pick(serverEnv.FACEBOOK_CLIENT_ID, facebookRow?.client_id_enc),
      pick(serverEnv.FACEBOOK_CLIENT_SECRET, facebookRow?.client_secret_enc),
    ),
  };

  cache = { value, expires: now + TTL_MS };
  return value;
}

/**
 * Convenience for the storefront / admin: which providers have BOTH credentials
 * resolvable (env or DB), independent of the show-button toggle.
 */
export async function socialProvidersReady(): Promise<{
  google: boolean;
  facebook: boolean;
}> {
  const creds = await resolveSocialCredentials();
  return { google: creds.google !== null, facebook: creds.facebook !== null };
}

const settingTruthy = (v: string | null | undefined): boolean => {
  if (!v) return false;
  const s = v.trim().toLowerCase();
  return s === "true" || s === "1" || s === "yes" || s === "on";
};

/**
 * Is GOOGLE login effectively active for shoppers right now? The admin toggle
 * (`auth.social.google_enabled`) AND its credentials resolving (env or admin panel) —
 * the SAME gate the storefront's login/register Google button uses. Google is the only
 * provider the OAuth auto-link applies to (`AUTH_POLICY.trustedLinkingProviders`), so
 * the /account « Connexion Google automatique » control is only meaningful when this is
 * true. Fail-closed on any read error.
 */
export async function googleLoginActive(): Promise<boolean> {
  try {
    const [ready, settings] = await Promise.all([
      socialProvidersReady(),
      getSettingsMap(),
    ]);
    return settingTruthy(settings["auth.social.google_enabled"]) && ready.google;
  } catch {
    return false;
  }
}
