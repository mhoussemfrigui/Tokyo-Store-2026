import "server-only";

import { getSettingsMap } from "@/modules/cms/setting/queries";
import { safeHref } from "@/lib/utils/safe-href";
import type { ConsentConfig } from "./categories";

/**
 * Server-side loader for the admin-configured consent settings (`consent.*`
 * site_settings). Mirrors src/lib/seo/config.ts: degrades to sane defaults on a
 * DB outage, and exposes a pure `parseConsentConfig(map)` so the shop layout —
 * which already fetches the settings map — can build the config without a second
 * query.
 */

function str(v: string | null | undefined): string | null {
  if (v == null) return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

function bool(v: string | null | undefined, fallback: boolean): boolean {
  if (v == null) return fallback;
  const t = v.trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(t)) return true;
  if (["false", "0", "no", "off"].includes(t)) return false;
  return fallback;
}

function int(v: string | null | undefined, fallback: number): number {
  const n = Number.parseInt((v ?? "").trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Build the consent config from an already-fetched settings map (no DB call). */
export function parseConsentConfig(s: Record<string, string | null>): ConsentConfig {
  return {
    enabled: bool(s["consent.enabled"], true),
    title: str(s["consent.title"]) ?? "Nous respectons votre vie privée",
    description:
      str(s["consent.description"]) ??
      "Nous utilisons des cookies pour assurer le bon fonctionnement du site, mesurer l'audience et améliorer votre expérience. Vous pouvez accepter, refuser ou personnaliser vos choix à tout moment.",
    // safeHref-guarded: these are rendered as <Link href> in the consent banner,
    // so a `javascript:`/protocol-relative value in settings can't smuggle script
    // execution. The defaults are same-origin paths, so they pass through unchanged.
    policyUrl: safeHref(str(s["consent.policy_url"]) ?? "/cookies"),
    privacyUrl: safeHref(str(s["consent.privacy_url"]) ?? "/confidentialite"),
    offer: {
      // Default OFF: the only functional cookie today (the httpOnly wishlist
      // token) is strictly-necessary/exempt, so offering a "functional" toggle
      // out of the box would be an illusory control. Owners who add genuinely
      // optional functional cookies can enable it.
      functional: bool(s["consent.functional_enabled"], false),
      analytics: bool(s["consent.analytics_enabled"], true),
      marketing: bool(s["consent.marketing_enabled"], true),
    },
    revision: int(s["consent.revision"], 1),
  };
}

/** Async loader (does its own settings read). Never throws — defaults survive DB outage. */
export async function getConsentConfig(): Promise<ConsentConfig> {
  let s: Record<string, string | null> = {};
  try {
    s = await getSettingsMap();
  } catch {
    /* keep defaults */
  }
  return parseConsentConfig(s);
}
