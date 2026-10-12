import type { AuthPagesConfig } from "@/lib/auth/pages-config";
import { AUTH_PAGE_DEFAULTS } from "@/lib/auth/pages-defaults";

/**
 * Bundled copy for the login / register pages, used when `getAuthPagesConfig()`
 * rejects (DB outage) — the auth pages must always render. Built from the SAME
 * `AUTH_PAGE_DEFAULTS` the storefront falls back to for an unset setting, so the
 * offline copy can never drift from the live default.
 *
 * Social providers default to OFF here on purpose: showing a Google / Facebook
 * button we cannot confirm is configured would dead-end the user.
 */
export const AUTH_PAGES_FALLBACK: AuthPagesConfig = {
  login: { ...AUTH_PAGE_DEFAULTS.login, perks: [...AUTH_PAGE_DEFAULTS.login.perks] },
  register: { ...AUTH_PAGE_DEFAULTS.register, perks: [...AUTH_PAGE_DEFAULTS.register.perks] },
  forgotPassword: { ...AUTH_PAGE_DEFAULTS.forgotPassword },
  resetPassword: { ...AUTH_PAGE_DEFAULTS.resetPassword },
  verifyEmail: { ...AUTH_PAGE_DEFAULTS.verifyEmail },
  social: { google: false, facebook: false },
};
