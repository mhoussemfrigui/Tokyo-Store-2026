import "server-only";

import { getSettingsMap } from "@/modules/cms/setting/queries";
import { getSiteLogoUrl } from "@/lib/api/cms";

/**
 * Admin-configurable settings for the redirects engine + the 404 page (Système →
 * Redirections & 404). Stored as `site_settings` rows; `getSettingsMap` is React
 * cache()'d so these reads are deduped with the rest of the request.
 */

function bool(v: string | null | undefined, fb: boolean): boolean {
  if (v == null) return fb;
  const s = v.trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(s)) return true;
  if (["false", "0", "no", "off"].includes(s)) return false;
  return fb;
}
function str(v: string | null | undefined): string | null {
  const t = (v ?? "").trim();
  return t.length ? t : null;
}

/** Master switch for the redirect engine (default ON). */
export async function isRedirectsEnabled(): Promise<boolean> {
  try {
    const s = await getSettingsMap();
    return bool(s["redirects.enabled"], true);
  } catch {
    return true; // settings unavailable → keep redirects working
  }
}

export type NotFoundConfig = {
  title: string;
  message: string;
  showSearch: boolean;
  showSuggestions: boolean;
  /** Médiathèque logo for the scene's top-left mark (null → the bundled mark). */
  logoUrl: string | null;
};

const NOT_FOUND_DEFAULTS: NotFoundConfig = {
  title: "Cette page est introuvable.",
  message:
    "Le lien est peut-être ancien, ou le produit n'est plus en vente. Vos produits, eux, sont toujours là.",
  showSearch: true,
  showSuggestions: true,
  logoUrl: null,
};

/** Admin-tunable 404 copy + toggles, with sensible defaults. */
export async function getNotFoundConfig(): Promise<NotFoundConfig> {
  let s: Record<string, string | null> = {};
  try {
    s = await getSettingsMap();
  } catch {
    return NOT_FOUND_DEFAULTS;
  }
  const logoUrl = await getSiteLogoUrl().catch(() => null);
  return {
    title: str(s["notfound.title"]) ?? NOT_FOUND_DEFAULTS.title,
    message: str(s["notfound.message"]) ?? NOT_FOUND_DEFAULTS.message,
    showSearch: bool(s["notfound.show_search"], true),
    showSuggestions: bool(s["notfound.show_suggestions"], true),
    logoUrl,
  };
}
