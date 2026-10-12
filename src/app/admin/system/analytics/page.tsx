import type { Metadata } from "next";

import { requirePermission } from "@/lib/auth/session";
import { resolveUserPermissions } from "@/lib/rbac/authorize";
import { WILDCARD } from "@/lib/rbac/registry";
import { getSettingsMap } from "@/modules/cms/setting/queries";
import { parseTrackingConfig } from "@/lib/tracking/config";
import { parseConsentConfig } from "@/lib/consent/config";
import { AnalyticsSettingsPanel } from "./analytics-settings-panel";

export const metadata: Metadata = { title: "Suivi & Analytics" };

export default async function AdminAnalyticsPage() {
  const session = await requirePermission("system_analytics", "view");
  // The GTM container id + the custom-code snippets can run arbitrary JS on the
  // storefront, so only a `*` holder may edit them (the action enforces it; the
  // panel greys them out for everyone else).
  const canEditScripts = (await resolveUserPermissions(session.user.id)).has(WILDCARD);
  // No `.catch`: a failed read must reach the admin error boundary (retry), not
  // pre-fill the form with defaults a save would persist (tracking off, ids blank).
  const s = await getSettingsMap();
  // parseTrackingConfig folds in the legacy `consent.*` ids, so the form
  // pre-fills from a pre-existing install on first open.
  const cfg = parseTrackingConfig(s);
  // The cookie-banner state is read here too so this tab can REFLECT it (issue
  // #2/#3): when the banner is off, Consent Mode is forced granted everywhere.
  const consent = parseConsentConfig(s);

  return (
    <AnalyticsSettingsPanel
      values={{
        enabled: cfg.enabled,
        bypassConsent: cfg.bypassConsent,
        mode: cfg.mode,
        gtmId: cfg.gtmId ?? "",
        ga4Id: cfg.ga4Id ?? "",
        metaPixelId: cfg.metaPixelId ?? "",
        customHead: cfg.customHead,
        customBody: cfg.customBody,
        regionEeaOnly: cfg.regionEeaOnly,
        waitForUpdate: cfg.waitForUpdate,
        adsDataRedaction: cfg.adsDataRedaction,
        urlPassthrough: cfg.urlPassthrough,
        signalDefaults: cfg.signalDefaults,
        events: cfg.events,
        consentBannerEnabled: consent.enabled,
      }}
      canEditScripts={canEditScripts}
    />
  );
}
