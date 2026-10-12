import "server-only";

import { getSettingsMap } from "@/modules/cms/setting/queries";
import { socialProvidersReady } from "@/lib/auth/social-config";
import { AUTH_PAGE_DEFAULTS } from "@/lib/auth/pages-defaults";

/**
 * Login / register page copy + social-button visibility, resolved from the
 * `auth.*` site settings (Admin → Clients → Connexion & comptes) with
 * hard-coded French defaults. A blank or unset setting falls back to the
 * default — there is no "explicitly empty" state for this copy, which keeps
 * the admin rule simple: clear the field to restore the default text.
 *
 * The defaults are intentionally VAGUE, brand-flavoured marketing lines — not
 * concrete promises (no "−10 %", no "précommandes prioritaires"). Keep them in
 * sync with the admin placeholders (auth-settings-panel.tsx) and the offline
 * fallback (components/auth/pages-fallback.ts).
 *
 * `social.google` / `social.facebook` are true only when the admin toggle is
 * on AND the provider's credentials resolve (env var OR the admin panel — see
 * src/lib/auth/social-config.ts; resolved credentials gate the provider, the
 * toggle gates the storefront buttons).
 *
 * Never throws: a settings read failure yields all defaults + social off,
 * so the login/register pages can always render.
 */

export type AuthPagesConfig = {
  login: { title: string; subtitle: string; panelTitle: string; panelSubtitle: string; perks: string[] };
  register: { title: string; panelBadge: string; panelTitle: string; perks: string[]; footnote: string };
  /** Recovery surfaces — copy for the forgot/reset/verify-email pages. */
  forgotPassword: { title: string; subtitle: string };
  resetPassword: {
    title: string;
    subtitle: string;
    invalidTitle: string;
    invalidBody: string;
  };
  verifyEmail: {
    incompleteTitle: string;
    incompleteBody: string;
    invalidTitle: string;
    invalidBody: string;
  };
  social: { google: boolean; facebook: boolean };
};

const truthy = (v: string | null | undefined): boolean => {
  if (!v) return false;
  const s = v.trim().toLowerCase();
  return s === "true" || s === "1" || s === "yes" || s === "on";
};

/** Trimmed setting value, or the fallback when unset/blank. */
function text(
  settings: Record<string, string | null>,
  key: string,
  fallback: string,
): string {
  const v = settings[key]?.trim();
  return v ? v : fallback;
}

/** Newline-separated setting → list. Blank/unset (or all-empty lines) → defaults. */
function perks(
  settings: Record<string, string | null>,
  key: string,
  fallback: readonly string[],
): string[] {
  const lines = (settings[key] ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.length > 0 ? lines : [...fallback];
}

export async function getAuthPagesConfig(): Promise<AuthPagesConfig> {
  let settings: Record<string, string | null> = {};
  try {
    settings = await getSettingsMap();
  } catch (err) {
    console.error("[auth] settings read failed — using auth page defaults", err);
    settings = {};
  }

  // A provider's button shows only when its credentials resolve (env OR admin
  // panel) AND the admin toggle is on. Readiness is independent of the toggle.
  const ready = await socialProvidersReady().catch(() => ({
    google: false,
    facebook: false,
  }));

  const D = AUTH_PAGE_DEFAULTS;
  return {
    login: {
      title: text(settings, "auth.login.title", D.login.title),
      subtitle: text(settings, "auth.login.subtitle", D.login.subtitle),
      panelTitle: text(settings, "auth.login.panel_title", D.login.panelTitle),
      panelSubtitle: text(settings, "auth.login.panel_subtitle", D.login.panelSubtitle),
      perks: perks(settings, "auth.login.perks", D.login.perks),
    },
    register: {
      title: text(settings, "auth.register.title", D.register.title),
      panelBadge: text(settings, "auth.register.panel_badge", D.register.panelBadge),
      panelTitle: text(settings, "auth.register.panel_title", D.register.panelTitle),
      perks: perks(settings, "auth.register.perks", D.register.perks),
      footnote: text(settings, "auth.register.footnote", D.register.footnote),
    },
    forgotPassword: {
      title: text(settings, "auth.forgot.title", D.forgotPassword.title),
      subtitle: text(settings, "auth.forgot.subtitle", D.forgotPassword.subtitle),
    },
    resetPassword: {
      title: text(settings, "auth.reset.title", D.resetPassword.title),
      subtitle: text(settings, "auth.reset.subtitle", D.resetPassword.subtitle),
      invalidTitle: text(settings, "auth.reset.invalid_title", D.resetPassword.invalidTitle),
      invalidBody: text(settings, "auth.reset.invalid_body", D.resetPassword.invalidBody),
    },
    verifyEmail: {
      incompleteTitle: text(settings, "auth.verify.incomplete_title", D.verifyEmail.incompleteTitle),
      incompleteBody: text(settings, "auth.verify.incomplete_body", D.verifyEmail.incompleteBody),
      invalidTitle: text(settings, "auth.verify.invalid_title", D.verifyEmail.invalidTitle),
      invalidBody: text(settings, "auth.verify.invalid_body", D.verifyEmail.invalidBody),
    },
    social: {
      google: truthy(settings["auth.social.google_enabled"]) && ready.google,
      facebook: truthy(settings["auth.social.facebook_enabled"]) && ready.facebook,
    },
  };
}
