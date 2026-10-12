import {
  getMaintenanceSceneData,
  getSiteModeConfig,
  requestIsSiteGateExempt,
  viewerCanBypassSiteGate,
} from "@/lib/site-mode/config";
import { isSiteGated } from "@/lib/site-mode/parse";
import { MaintenanceScene } from "@/components/maintenance-scene";

/**
 * Root of the `(shop)` group — a deliberately THIN layout that renders NO chrome.
 *
 * It has two jobs, and both REQUIRE it to sit ABOVE the header/footer chrome
 * (which now lives one level down in `(shell)/layout.tsx`):
 *
 * 1. ── The 404 boundary ───────────────────────────────────────────────────────
 *    `(shop)/not-found.tsx` renders inside THIS layout and discards every layout
 *    below it — including `(shell)`'s header/footer. That is what makes a storefront
 *    404 chrome-free on both server AND client, matching `/admin`. If the chrome
 *    were rendered here, a matched `[slug]` that calls `notFound()` would re-inherit
 *    it on the client (Next keeps a matched route's group layout around the
 *    not-found boundary).
 *
 * 2. ── Maintenance / coming-soon : the hard gate ──────────────────────────────
 *    Kept UP here (not in `(shell)`) on purpose: because it runs before `children`
 *    it also covers the 404 boundary, so a closed shop shows the full-page
 *    MaintenanceScene even on an unknown URL instead of leaking a branded 404 that
 *    reveals the site is up. Reads the site mode FIRST (cheap, cache()'d) and
 *    short-circuits before `(shell)`'s expensive chrome fan-out ever runs. Non-exempt
 *    public visitors get the MaintenanceScene; EXEMPT routes (gate-exempt.ts: the
 *    session-less continuation pages — /login(/2fa), /forgot-password +
 *    /reset-password, /verify-email, /se-desabonner) and signed-in STAFF (bypass)
 *    fall through to `children`, where `(shell)` decides chrome vs the exempt bare
 *    shell. The gate reads only this runtime can make (the edge can't reach the DB);
 *    `/admin` + `/admin-login` live outside this group entirely. Fails OPEN — a
 *    settings read error ⇒ `live`.
 */
export default async function ShopLayout({ children }: { children: React.ReactNode }) {
  const siteMode = await getSiteModeConfig();
  if (
    isSiteGated(siteMode.mode) &&
    !(await viewerCanBypassSiteGate()) &&
    !(await requestIsSiteGateExempt())
  ) {
    // Fetch the scene's backend data (logo + boutiques + phone/WhatsApp) ONLY now
    // that the gate is confirmed up — a live request never pays for it.
    const data = await getMaintenanceSceneData();
    return <MaintenanceScene config={siteMode} data={data} />;
  }
  return children;
}
