import "server-only";

import { getSettingsMap } from "@/modules/cms/setting/queries";

/**
 * Is the public-favorites feature globally enabled? OFF by default (unset →
 * disabled) — matching migration 0057, docs/database.md + docs/modules.md, and
 * the « Désactivé par défaut » admin copy: public sharing must not go live on a
 * store that never opted in. The admin switches it on from the Favoris tab.
 * Independently, each customer's OWN profile still starts PRIVATE — publishing
 * is a per-user opt-in (`setPublicFavoritesAction`).
 *
 * Lives in a plain server-only module, NOT in the "use server" actions file:
 * every export there is a callable RPC endpoint, and this is a read helper for
 * server components + actions, not an action.
 *
 * FAILS CLOSED: an unset setting AND a settings-read error both read as OFF
 * (public profiles 404, publishing is refused) so the feature is never live
 * unless an operator explicitly enabled it — the next request re-reads it.
 */
export async function favoritesPublicEnabled(): Promise<boolean> {
  let s: Record<string, string | null>;
  try {
    s = await getSettingsMap();
  } catch {
    return false;
  }
  return (s["social.favorites_public_enabled"]?.trim() || "false") === "true";
}
