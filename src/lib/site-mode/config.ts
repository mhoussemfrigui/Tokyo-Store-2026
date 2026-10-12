import "server-only";

import { headers } from "next/headers";

import { getSettingsMap } from "@/modules/cms/setting/queries";
import { getCurrentUser } from "@/lib/auth/session";
import { canAccessAdminArea } from "@/lib/rbac/authorize";
import { getSiteLogoUrl } from "@/lib/api/cms";
import { getSiteContacts, footerEntries } from "@/lib/cms/contact-list";
import { resolveSocialList } from "@/lib/cms/social-list";
import type { MaintenanceSceneData } from "@/components/maintenance-scene";
import { isSiteGated, resolveSiteModeConfig, type SiteModeConfig } from "./parse";
import { isSiteGateExemptPath, SITE_PATH_HEADER } from "./gate-exempt";

/**
 * Site-availability config for the storefront gate + the admin panel.
 *
 * `getSettingsMap` is React `cache()`'d, so the (shop) layout's read here is deduped
 * with the rest of the request. FAIL OPEN: if settings are unavailable the resolver
 * runs on `{}` → `live`, so a DB hiccup never blanks the store behind a maintenance
 * wall.
 */
export async function getSiteModeConfig(): Promise<SiteModeConfig> {
  try {
    return resolveSiteModeConfig(await getSettingsMap());
  } catch {
    return resolveSiteModeConfig({});
  }
}

/**
 * Backend identity + contacts for the gated (maintenance / coming-soon) scene:
 * the médiathèque logo, the footer-flagged boutiques, the contact phone and the
 * WhatsApp number — all from « Identité & contact ». `getSettingsMap` is cache()'d
 * so this shares the mode read. Fetched ONLY when the gate is up (the (shop) layout
 * calls it inside the gate branch), so a live request never pays for it. Every
 * field degrades to empty on any failure → the scene's sections self-hide.
 */
export async function getMaintenanceSceneData(): Promise<MaintenanceSceneData> {
  try {
    const [settings, logoUrl] = await Promise.all([
      getSettingsMap(),
      getSiteLogoUrl().catch(() => null),
    ]);
    const contacts = getSiteContacts(settings);
    return {
      logoUrl,
      stores: footerEntries(contacts.addresses).map((e) => e.value),
      phone: footerEntries(contacts.phones)[0]?.value ?? settings["site.contact_phone"] ?? null,
      whatsapp: contacts.whatsapp,
      socials: resolveSocialList(settings),
    };
  } catch {
    return {};
  }
}

/**
 * May the current viewer BYPASS the maintenance/coming-soon gate? True for any
 * signed-in staff member — anyone who can enter the admin area (holds ≥1 grant).
 * This is what lets an admin preview the live storefront while the public sees the
 * gate. Fail CLOSED here (a resolution error ⇒ no bypass ⇒ the visitor sees the
 * gate) — the opposite bias from getSiteModeConfig, and the safe one for each.
 */
export async function viewerCanBypassSiteGate(): Promise<boolean> {
  try {
    const user = await getCurrentUser();
    if (!user) return false;
    return await canAccessAdminArea(user.id);
  } catch {
    return false;
  }
}

/**
 * Is the storefront CLOSED to the current request? The ONE check the public
 * NON-PAGE surfaces use (the /md twins, /api/store/search, /feeds, sitemap.xml,
 * robots.txt; llms.txt reads `getSiteModeConfig` itself because its gated body
 * quotes the gate copy) — the (shop) layout gate only covers pages, so without
 * this a gated (esp. pre-launch coming_soon) store still lists its catalogue to
 * any client/crawler through those machine surfaces.
 *
 * Keeps BOTH biases of the layout gate: the mode lookup fails OPEN (a settings
 * error ⇒ `live` ⇒ false) and the staff bypass fails CLOSED.
 *
 * `allowStaff` (default true): a signed-in staff member bypasses the gate, like
 * the layout — right for viewer-facing surfaces (search box, /md). Pass `false`
 * for the cookie-free machine files (sitemap, robots, llms, feeds): they're
 * CDN/ISR-cached and must never vary per viewer.
 */
export async function isSiteGatedForViewer(
  opts: { allowStaff?: boolean } = {},
): Promise<boolean> {
  const { mode } = await getSiteModeConfig();
  if (!isSiteGated(mode)) return false;
  if (opts.allowStaff === false) return true;
  return !(await viewerCanBypassSiteGate());
}

/**
 * Is the CURRENT request for a gate-exempt page (/login(/2fa), /reset-password,
 * /forgot-password, /verify-email, /se-desabonner — see gate-exempt.ts)? Reads
 * the pathname header src/proxy.ts always overwrites. Missing header or a read
 * error ⇒ false, i.e. the page stays gated (the pre-existing behaviour).
 */
export async function requestIsSiteGateExempt(): Promise<boolean> {
  try {
    return isSiteGateExemptPath((await headers()).get(SITE_PATH_HEADER));
  } catch {
    return false;
  }
}
