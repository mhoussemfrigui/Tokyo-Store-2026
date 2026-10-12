import { permanentRedirect } from "next/navigation";

/**
 * MOVED — « Connexion & comptes » was consolidated into Utilisateurs → Réglages
 * (/admin/users/settings), alongside the session-policy panel. This route stays
 * as a permanent (308) redirect so bookmarks + old deep links keep working; the
 * target page carries the real RBAC guard (requirePermissionAny over
 * USER_SETTINGS_VIEW_GRANTS), so no guard is needed on this pure stub.
 */
export default function AuthSettingsRedirect(): never {
  permanentRedirect("/admin/users/settings");
}
