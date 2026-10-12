import type { Metadata } from "next";

import { requirePermissionAny } from "@/lib/auth/session";
import { permissionSetAllows, resolveUserPermissions } from "@/lib/rbac/authorize";
import { USER_SETTINGS_VIEW_GRANTS } from "@/lib/rbac/nav-access";
import { getSettingsMap } from "@/modules/cms/setting/queries";
import { oauthSettingsService, type OAuthProviderSettingsRow } from "@/modules/oauth";
import { serverEnv } from "@/lib/env";
import { socialEnvLock } from "@/lib/auth/social-config";
import { isEncryptionConfigured } from "@/lib/crypto/secrets";
import { SESSION_POLICY_BOUNDS, SESSION_POLICY_KEYS } from "@/lib/auth/policy";
import { AdminPageHeader } from "@/components/admin/page-header";

import { UsersSubnav } from "../users-subnav";
import { AuthSettingsPanel, type ProviderCredData } from "./auth-settings-panel";
import { SessionPolicyPanel } from "./session-policy-panel";

export const metadata: Metadata = { title: "Réglages — Utilisateurs" };

type ProviderDef = {
  provider: "google" | "facebook";
  label: string;
  idEnv: string;
  secretEnv: string;
};

const PROVIDERS: ProviderDef[] = [
  { provider: "google", label: "Google", idEnv: "GOOGLE_CLIENT_ID", secretEnv: "GOOGLE_CLIENT_SECRET" },
  { provider: "facebook", label: "Facebook", idEnv: "FACEBOOK_CLIENT_ID", secretEnv: "FACEBOOK_CLIENT_SECRET" },
];

/** Read a clamped numeric setting, falling back to its default. */
function readNum(
  settings: Record<string, string | null>,
  key: string,
  b: { def: number; min: number; max: number },
): number {
  const v = Number(settings[key]);
  return Number.isFinite(v) && v >= b.min && v <= b.max ? Math.round(v) : b.def;
}

/**
 * Utilisateurs → Réglages — the consolidated access/auth settings home. Replaces
 * the former standalone `/admin/system/auth` (which now 308-redirects here) and
 * absorbs the session-policy panel that used to live on the Rôles page. Two
 * independent panels, each gated by its own grant:
 *   • Sessions & sécurité (session lifetime policy) — users:policy (the same grant
 *     its save enforces).
 *   • Connexion & comptes (login/register copy, social toggles, OAuth creds) —
 *     system_auth:view to see, system_auth:update to save.
 *
 * The page opens for ANY of USER_SETTINGS_VIEW_GRANTS (users:view, users:policy,
 * system_auth:view) — the same list the sidebar item's visibleWhen uses — so a
 * `system_auth`-only or `users:policy`-only operator still reaches its panel (the
 * subnav then shows only the Réglages pill). A panel the operator can't use is
 * simply not rendered.
 *
 * Settings reads here are STRICT (no fail-soft `.catch(() => ({}))`): both panels
 * pre-fill a save form, so a swallowed read would show defaults a save then
 * persists over the live config. A read failure reaches the admin error boundary.
 */
export default async function UsersSettingsPage() {
  const session = await requirePermissionAny(USER_SETTINGS_VIEW_GRANTS);
  const perms = await resolveUserPermissions(session.user.id);
  const canViewUsers = permissionSetAllows(perms, "users", "view");
  // The session-policy panel gates on users:policy — the SAME grant its save action
  // enforces (session-policy.ts). A holder of just users:policy reaches this page
  // via USER_SETTINGS_VIEW_GRANTS (which includes it), and a users:manage operator
  // WITHOUT policy no longer sees a control whose save it can't perform.
  const canSetPolicy = permissionSetAllows(perms, "users", "policy");
  const canViewAuth = permissionSetAllows(perms, "system_auth", "view");

  // One settings read shared by both panels (only when at least one is shown).
  const settings =
    canSetPolicy || canViewAuth
      ? await getSettingsMap()
      : ({} as Record<string, string | null>);

  // ── Sessions & sécurité (users:policy) ──
  const sessionPolicy = {
    expiresDays: readNum(settings, SESSION_POLICY_KEYS.expiresDays, SESSION_POLICY_BOUNDS.expiresDays),
    updateAgeDays: readNum(settings, SESSION_POLICY_KEYS.updateAgeDays, SESSION_POLICY_BOUNDS.updateAgeDays),
    cookieCacheMinutes: readNum(
      settings,
      SESSION_POLICY_KEYS.cookieCacheMinutes,
      SESSION_POLICY_BOUNDS.cookieCacheMinutes,
    ),
  };

  // ── Connexion & comptes (system_auth) — only computed when viewable ──
  let authSettings: Record<string, string | null> = {};
  let providers: ProviderCredData[] = [];
  let authOriginDiffers = false;
  if (canViewAuth) {
    const oauthRows = await oauthSettingsService
      .listAll()
      .catch(() => [] as OAuthProviderSettingsRow[]);
    const byProvider = new Map(oauthRows.map((r) => [r.provider, r]));

    // Forward ONLY the `auth.*` keys to the client panel — getSettingsMap() holds
    // the whole site_settings table incl. OTHER panels' encrypted secrets
    // (e.g. mail.*_enc); the panel reads only auth.*, so this is behaviour-preserving.
    authSettings = Object.fromEntries(
      Object.entries(settings).filter(([k]) => k.startsWith("auth.")),
    );

    // OAuth callback base — what each provider console must whitelist. better-auth
    // derives redirect_uri from BETTER_AUTH_URL (NOT NEXT_PUBLIC_SITE_URL), so this
    // MUST use BETTER_AUTH_URL or a split-host topology breaks every social sign-in.
    const callbackBase = `${serverEnv.BETTER_AUTH_URL.replace(/\/$/, "")}/api/auth/callback`;
    authOriginDiffers = (() => {
      try {
        return new URL(serverEnv.BETTER_AUTH_URL).origin !== new URL(serverEnv.NEXT_PUBLIC_SITE_URL).origin;
      } catch {
        return false;
      }
    })();

    providers = PROVIDERS.map((d) => {
      const row = byProvider.get(d.provider);
      // A set env var force-overrides + locks the field (single source of truth —
      // src/lib/auth/social-config.ts).
      const lock = socialEnvLock(d.provider);
      const idLocked = lock.id;
      const secretLocked = lock.secret;
      const idHasValue = idLocked || Boolean(row?.client_id_enc);
      const secretHasValue = secretLocked || Boolean(row?.client_secret_enc);
      return {
        provider: d.provider,
        label: d.label,
        ready: idHasValue && secretHasValue,
        callbackUrl: `${callbackBase}/${d.provider}`,
        idField: {
          name: `secret.${d.provider}.client_id`,
          label: "Client ID",
          hasValue: idHasValue,
          locked: idLocked,
          envVar: d.idEnv,
        },
        secretField: {
          name: `secret.${d.provider}.client_secret`,
          label: "Client secret",
          hasValue: secretHasValue,
          locked: secretLocked,
          envVar: d.secretEnv,
        },
      };
    });
  }

  return (
    <div className="space-y-6">
      {/* A system_auth-only operator (no users:view) sees ONLY the Réglages pill. */}
      <UsersSubnav show={canViewUsers ? ["comptes", "roles", "reglages"] : ["reglages"]} />
      <AdminPageHeader
        title="Réglages"
        description="Politique de session (durée de connexion de tous les comptes) et configuration de la connexion : textes des pages de connexion / inscription, connexion sociale (Google / Facebook) et identifiants OAuth."
      />

      {canSetPolicy && <SessionPolicyPanel current={sessionPolicy} />}

      {canViewAuth && (
        <AuthSettingsPanel
          settings={authSettings}
          providers={providers}
          encryptionReady={isEncryptionConfigured()}
          authOriginDiffers={authOriginDiffers}
        />
      )}

      {!canSetPolicy && !canViewAuth && (
        <p className="rounded-[22px] border border-dashed border-border bg-card p-8 text-center text-[14px] text-muted-foreground">
          Vous n&apos;avez pas les droits pour modifier ces réglages.
        </p>
      )}
    </div>
  );
}
