/**
 * SINGLE SOURCE OF TRUTH for the login / register / recovery page copy defaults.
 *
 * Client-safe (no server-only imports) so all THREE consumers import the SAME
 * values and can never drift:
 *   - getAuthPagesConfig (src/lib/auth/pages-config.ts) — the storefront's unset-
 *     setting fallbacks;
 *   - AUTH_PAGES_FALLBACK (src/components/auth/pages-fallback.ts) — the offline copy
 *     when the settings read fails;
 *   - the admin panel (auth-settings-panel.tsx) — the field pre-fill + placeholders.
 *
 * Before this module the three had drifted, so an admin who saved after only
 * toggling Google silently rewrote the live login/register copy to the panel's
 * alternate wording. Pinned by auth-page-defaults.test.ts.
 *
 * Keep the lines VAGUE, brand-flavoured marketing — never concrete promises
 * (no "−10 %", no "précommandes prioritaires").
 */
export const AUTH_PAGE_DEFAULTS = {
  login: {
    title: "Bon retour parmi nous",
    subtitle: "Accédez à votre espace personnel",
    panelTitle: "La high-tech de pointe vous attend.",
    panelSubtitle:
      "Retrouvez vos commandes, vos produits favoris et toute votre sélection, au même endroit.",
    perks: [
      "Tout votre high-tech, au même endroit",
      "Une sélection pensée pour les passionnés de technologie",
      "Le suivi de vos commandes et de vos favoris",
    ],
  },
  register: {
    title: "Rejoignez Tokyo Store",
    panelBadge: "Club Tokyo Store",
    panelTitle: "Plus qu'un compte — votre hub high-tech.",
    perks: [
      "Tout votre high-tech, au même endroit",
      "Une sélection pensée pour les passionnés de technologie",
      "Le suivi de vos commandes et de vos favoris",
      "Des nouveautés tout au long de l'année",
    ],
    footnote: "Gratuit, sans engagement. Désinscription à tout moment.",
  },
  forgotPassword: {
    title: "Mot de passe oublié ?",
    subtitle: "Entrez votre email et nous vous enverrons un lien pour en choisir un nouveau.",
  },
  resetPassword: {
    title: "Nouveau mot de passe",
    subtitle: "Choisissez un mot de passe d'au moins 12 caractères.",
    invalidTitle: "Lien invalide",
    invalidBody: "Le lien de réinitialisation est incomplet ou expiré.",
  },
  verifyEmail: {
    incompleteTitle: "Lien incomplet",
    incompleteBody: "Le lien de vérification est invalide ou expiré.",
    invalidTitle: "Lien invalide",
    invalidBody: "Le lien de vérification est invalide ou expiré.",
  },
} as const;

/** Perks joined the way they are STORED (one per line) — for the panel pre-fill. */
export const AUTH_PERKS_AS_TEXT = {
  login: AUTH_PAGE_DEFAULTS.login.perks.join("\n"),
  register: AUTH_PAGE_DEFAULTS.register.perks.join("\n"),
} as const;
