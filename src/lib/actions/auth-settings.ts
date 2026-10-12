"use server";

import { revalidatePath } from "next/cache";

import { workflows } from "@/workflows";
import {
  clearOAuthSettingsWorkflow,
  upsertOAuthSettingsWorkflow,
} from "@/workflows/auth/upsert-oauth-settings";
import { requirePermission } from "@/lib/auth/session";
import { isEncryptionConfigured } from "@/lib/crypto/secrets";
import { resetAuthInstance } from "@/lib/auth/server";
import { invalidateSocialConfigCache } from "@/lib/auth/social-config";
import { EMAIL_VERIFICATION_REQUIRED_KEY } from "@/lib/auth/policy";
import { type ActionState } from "@/lib/actions/types";

/**
 * Bulk-saves the `auth.*` settings (login/register page copy + social-login
 * toggles + Google/Facebook OAuth credentials) from the Utilisateurs → Réglages
 * (/admin/users/settings) form — one submit, one action call, same pattern as
 * `saveCheckoutSettingsAction`. The form field names match the setting keys
 * 1:1; unknown FormData entries are ignored.
 *
 * Blank text fields are stored as null — `getAuthPagesConfig`
 * (src/lib/auth/pages-config.ts) then falls back to the built-in French
 * defaults, so clearing a field restores the default copy.
 *
 * A provider is live only when its toggle is ON AND its credentials resolve —
 * from a set `GOOGLE_*` / `FACEBOOK_*` env var (force-override) OR the encrypted
 * values saved here into `oauth_provider_settings` (buildSocialProviders in
 * lib/auth/server.ts; the storefront buttons follow the same rule). Credentials
 * are write-only (an empty field keeps the stored value; « Supprimer les
 * identifiants » — `clearOAuthCredentialsAction` — erases them),
 * AES-256-GCM-encrypted at rest and audited with the acting admin (both writes go
 * through workflows/auth/upsert-oauth-settings.ts), mirroring the payments page. Every save
 * rebuilds the cached auth instance (`resetAuthInstance`) so a toggle or
 * credential change applies on the next request without a redeploy.
 */

/** Social providers whose OAuth credentials this page can store. */
const SOCIAL_CRED_PROVIDERS = [
  { provider: "google" as const, idEnv: "GOOGLE_CLIENT_ID", secretEnv: "GOOGLE_CLIENT_SECRET" },
  { provider: "facebook" as const, idEnv: "FACEBOOK_CLIENT_ID", secretEnv: "FACEBOOK_CLIENT_SECRET" },
];

const envSet = (name: string): boolean => Boolean((process.env[name] ?? "").trim());

type Field = {
  key: string;
  label: string;
  description?: string;
  // Matches the workflow's `upsertSettingSchema.type` enum.
  type?: "text" | "boolean" | "number" | "media";
};

/**
 * The set of settings the Utilisateurs → Réglages (/admin/users/settings) page
 * edits. Keep this in sync with the form on that page.
 */
const AUTH_FIELDS: Field[] = [
  // Security — is email verification obligatoire before login? (default ON)
  {
    key: EMAIL_VERIFICATION_REQUIRED_KEY,
    label: "Vérification e-mail obligatoire",
    type: "boolean",
  },
  // Social login on/off (gates the provider AND its storefront button)
  { key: "auth.social.google_enabled", label: "Connexion Google — activée", type: "boolean" },
  { key: "auth.social.facebook_enabled", label: "Connexion Facebook — activée", type: "boolean" },
  // Login page copy
  { key: "auth.login.title", label: "Connexion — titre", type: "text" },
  { key: "auth.login.subtitle", label: "Connexion — sous-titre", type: "text" },
  { key: "auth.login.panel_title", label: "Connexion — titre du panneau", type: "text" },
  { key: "auth.login.panel_subtitle", label: "Connexion — sous-titre du panneau", type: "text" },
  { key: "auth.login.perks", label: "Connexion — avantages (un par ligne)", type: "text" },
  // Register page copy
  { key: "auth.register.title", label: "Inscription — titre", type: "text" },
  { key: "auth.register.panel_badge", label: "Inscription — badge du panneau", type: "text" },
  { key: "auth.register.panel_title", label: "Inscription — titre du panneau", type: "text" },
  { key: "auth.register.perks", label: "Inscription — avantages (un par ligne)", type: "text" },
  { key: "auth.register.footnote", label: "Inscription — note de bas de page", type: "text" },
  // Forgot-password page copy
  { key: "auth.forgot.title", label: "Mot de passe oublié — titre", type: "text" },
  { key: "auth.forgot.subtitle", label: "Mot de passe oublié — sous-titre", type: "text" },
  // Reset-password page copy
  { key: "auth.reset.title", label: "Réinitialisation — titre", type: "text" },
  { key: "auth.reset.subtitle", label: "Réinitialisation — sous-titre", type: "text" },
  { key: "auth.reset.invalid_title", label: "Réinitialisation — titre lien invalide", type: "text" },
  { key: "auth.reset.invalid_body", label: "Réinitialisation — texte lien invalide", type: "text" },
  // Verify-email page copy
  { key: "auth.verify.incomplete_title", label: "Vérification email — titre lien incomplet", type: "text" },
  { key: "auth.verify.incomplete_body", label: "Vérification email — texte lien incomplet", type: "text" },
  { key: "auth.verify.invalid_title", label: "Vérification email — titre lien invalide", type: "text" },
  { key: "auth.verify.invalid_body", label: "Vérification email — texte lien invalide", type: "text" },
];

export async function saveAuthSettingsAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  const session = await requirePermission("system_auth", "update");

  // Guard UP FRONT: if the admin typed any OAuth credential while encryption is not
  // configured, refuse BEFORE writing ANY setting. Otherwise the settings loop below
  // persists everything (incl. the security-relevant email-verification toggle) and
  // the mid-loop early-return skips resetAuthInstance(), so the cached auth instance
  // keeps enforcing the OLD toggle while the UI reports failure.
  const anyCredTyped = SOCIAL_CRED_PROVIDERS.some((p) => {
    const id = envSet(p.idEnv) ? "" : String(formData.get(`secret.${p.provider}.client_id`) ?? "").trim();
    const secret = envSet(p.secretEnv) ? "" : String(formData.get(`secret.${p.provider}.client_secret`) ?? "").trim();
    return Boolean(id || secret);
  });
  if (anyCredTyped && !isEncryptionConfigured()) {
    return {
      ok: false,
      error: "no_encryption_key",
      message:
        "Définissez PAYMENT_ENCRYPTION_KEY (ex. `openssl rand -base64 32`) avant d'enregistrer des identifiants OAuth.",
    };
  }

  const errors: string[] = [];
  for (const field of AUTH_FIELDS) {
    // Booleans: checkboxes submit "on" when ticked, nothing when not.
    // We always write so the off state is persisted.
    let value: string | null;
    if (field.type === "boolean") {
      value = formData.get(field.key) === "on" ? "true" : "false";
    } else {
      const raw = formData.get(field.key);
      value = raw === null ? null : String(raw).trim() || null;
    }

    const result = await workflows.cms.upsertSetting(
      {
        key: field.key,
        value,
        type: field.type ?? "text",
        groupKey: "auth",
        label: field.label,
        description: field.description,
      },
      { actorUserId: session.user.id },
    );
    if (!result.ok) errors.push(`${field.label}: ${result.message}`);
  }

  // ── Social OAuth credentials (encrypted at rest) ──────────────────────────
  // Write-only: a field is saved only when the admin typed a value AND it isn't
  // env-locked (a set env var force-overrides, so its input is disabled and
  // submits nothing). An empty field keeps whatever is stored.
  let credsChanged = false;
  for (const p of SOCIAL_CRED_PROVIDERS) {
    const rawId = envSet(p.idEnv)
      ? ""
      : String(formData.get(`secret.${p.provider}.client_id`) ?? "").trim();
    const rawSecret = envSet(p.secretEnv)
      ? ""
      : String(formData.get(`secret.${p.provider}.client_secret`) ?? "").trim();
    if (!rawId && !rawSecret) continue;
    // Encryption is guaranteed configured here (the up-front guard returned already
    // if a credential was typed without it), so no mid-loop early-return can skip
    // the resetAuthInstance() / revalidate below.

    // Encrypt + write + audit (`auth.oauth_settings_updated`, field NAMES only,
    // with this admin as the actor) in the workflow.
    const saved = await upsertOAuthSettingsWorkflow(
      { provider: p.provider, clientId: rawId || undefined, clientSecret: rawSecret || undefined },
      { actorUserId: session.user.id },
    );
    if (saved.ok) {
      credsChanged = true;
    } else {
      errors.push(`Identifiants ${p.provider} : enregistrement impossible.`);
    }
  }

  // The cached Better Auth instance captures the email-verification toggle AND
  // any provider credentials at construction, so ALWAYS rebuild it after a save
  // (the verification toggle is written on every submit). Only drop the social-
  // resolver cache when credentials actually changed.
  if (credsChanged) invalidateSocialConfigCache();
  resetAuthInstance();

  // The login/register/recovery pages + storefront layout read these settings
  // — refresh so changes propagate without redeploy.
  revalidatePath("/login");
  revalidatePath("/register");
  revalidatePath("/forgot-password");
  revalidatePath("/reset-password");
  revalidatePath("/verify-email");
  revalidatePath("/admin/users/settings");
  revalidatePath("/", "layout");

  if (errors.length > 0) {
    return {
      ok: false,
      error: "partial",
      message: `Certains réglages n'ont pas été enregistrés : ${errors.join(" · ")}`,
    };
  }
  return { ok: true, message: "Réglages enregistrés." };
}

/**
 * « Supprimer les identifiants » — erase the admin-saved (encrypted) OAuth client
 * id + secret of one provider. The save form is write-only (an empty field keeps
 * the stored value), so without this a credential could never be removed short
 * of editing the database. Rebuilds the auth instance so the provider is
 * unregistered on the next request. A set env var still force-overrides (and is
 * reported as such).
 */
export async function clearOAuthCredentialsAction(provider: string): Promise<ActionState> {
  const session = await requirePermission("system_auth", "update");

  const def = SOCIAL_CRED_PROVIDERS.find((p) => p.provider === provider);
  if (!def) return { ok: false, error: "validation", message: "Fournisseur inconnu." };
  const label = def.provider === "google" ? "Google" : "Facebook";

  // Erase + audit (`auth.oauth_settings_updated` « cleared », with the actor).
  const cleared = await clearOAuthSettingsWorkflow(
    { provider: def.provider },
    { actorUserId: session.user.id },
  );
  if (!cleared.ok) {
    return {
      ok: false,
      error: "internal",
      message: `Suppression des identifiants ${label} impossible. Réessayez.`,
    };
  }

  invalidateSocialConfigCache();
  resetAuthInstance();
  revalidatePath("/login");
  revalidatePath("/register");
  revalidatePath("/admin/users/settings");
  revalidatePath("/", "layout");

  if (envSet(def.idEnv) || envSet(def.secretEnv)) {
    return {
      ok: true,
      message: `Identifiants ${label} enregistrés supprimés. Les variables d'environnement (${def.idEnv} / ${def.secretEnv}) restent prioritaires tant qu'elles sont définies.`,
    };
  }
  return { ok: true, message: `Identifiants ${label} supprimés — la connexion ${label} est désactivée.` };
}
