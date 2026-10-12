/**
 * OAuth (Google / Facebook) sign-in error surface — PURE (no `server-only`, no
 * better-auth import), shared by the social buttons (which tell Better Auth
 * where to send a failed callback) and the /login form (which turns the
 * resulting `?error=<code>` into French copy).
 *
 * Without an `errorCallbackURL`, a failed OAuth callback lands on Better Auth's
 * built-in, unbranded English page under /api/auth/error — e.g. when the
 * `account.create.before` gate (src/lib/auth/server.ts) refuses a silent link
 * onto an existing password account (`unable_to_link_account`).
 */

/**
 * `errorCallbackURL` for `authClient.signIn.social`: back to /login, carrying
 * the post-login destination as `from` so a retry (password or social) still
 * lands where the shopper was going (checkout, /pro…). Better Auth appends
 * `&error=<code>` itself. Its relative-path allow-list only accepts
 * `[\w\-.+/=&%@]` in the query, so a destination whose encoding would contain
 * anything else (`!*'()~`) falls back to plain /login rather than having the
 * whole sign-in refused as INVALID_ERROR_CALLBACK_URL.
 */
export function oauthErrorCallbackURL(safeCallback: string): string {
  if (!safeCallback || safeCallback === "/account") return "/login";
  const encoded = encodeURIComponent(safeCallback);
  return /^[\w\-.%]+$/.test(encoded) ? `/login?from=${encoded}` : "/login";
}

/**
 * French message for an OAuth `?error=` code (Better Auth joins its internal
 * error text with underscores, e.g. "unable to link account" →
 * `unable_to_link_account`; our own hook throws surface by message, e.g.
 * `ACCOUNT_DISABLED`). Unknown codes get a generic line. Returns null when no
 * code is present.
 */
export function oauthErrorMessage(code: string | null | undefined): string | null {
  const c = code?.trim();
  if (!c) return null;
  switch (c.toLowerCase()) {
    // account.create.before refused the silent link (OAUTH_AUTOLINK_DISABLED):
    // an email/password account already owns this address.
    case "unable_to_link_account":
    case "oauth_autolink_disabled":
      return "Un compte existe déjà avec cette adresse e-mail. Connectez-vous avec votre mot de passe, puis activez « Connexion Google automatique » dans votre profil (Mon compte) pour pouvoir utiliser Google.";
    // Better Auth refused to link (local email not verified, or a provider that
    // never auto-links, e.g. Facebook).
    case "account_not_linked":
      return "Un compte existe déjà avec cette adresse e-mail. Connectez-vous avec votre e-mail et votre mot de passe.";
    case "account_disabled":
      return "Votre compte a été désactivé. Contactez le support pour plus d'informations.";
    // session.create.before refused a social sign-in for a 2FA-enabled account:
    // the second factor is never bypassed by an OAuth callback (server.ts).
    case "two_factor_required":
      return "Ce compte utilise la double authentification. Connectez-vous avec votre e-mail et votre mot de passe, puis validez le code à usage unique.";
    case "email_not_found":
      return "Votre compte social ne partage pas d'adresse e-mail. Autorisez l'accès à votre e-mail ou connectez-vous avec votre e-mail et votre mot de passe.";
    case "access_denied":
      return "Connexion annulée. Vous pouvez réessayer ou vous connecter avec votre e-mail.";
    case "signup_disabled":
      return "Aucun compte n'est associé à cette adresse. Créez d'abord un compte avec votre e-mail.";
    default:
      return "La connexion via Google ou Facebook a échoué. Réessayez, ou connectez-vous avec votre e-mail et votre mot de passe.";
  }
}
