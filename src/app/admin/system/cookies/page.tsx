import type { Metadata } from "next";

import { requirePermission } from "@/lib/auth/session";
import { getSettingsMap } from "@/modules/cms/setting/queries";
import { parseTrackingConfig } from "@/lib/tracking/config";
import { CookieSettingsPanel } from "./cookie-settings-panel";

export const metadata: Metadata = { title: "Cookies & RGPD" };

export default async function CookieSettingsPage() {
  await requirePermission("system_cookies", "view");
  // No `.catch`: a failed read must reach the admin error boundary (retry), not
  // pre-fill the form with defaults (revision « 1 », categories reset) that a
  // save would persist.
  const s = await getSettingsMap();
  const v = (k: string) => s[k] ?? "";
  const bool = (k: string, fb: boolean) => {
    const t = (s[k] ?? "").trim().toLowerCase();
    if (["true", "1", "on", "yes"].includes(t)) return true;
    if (["false", "0", "off", "no"].includes(t)) return false;
    return fb;
  };
  // Cross-tab (issue #3): surface the Suivi & Analytics bypass here, since it
  // OVERRIDES this banner (tracks everyone regardless of the categories below).
  const tracking = parseTrackingConfig(s);

  return (
    <CookieSettingsPanel
      values={{
        enabled: bool("consent.enabled", true),
        title: v("consent.title"),
        description: v("consent.description"),
        policyUrl: v("consent.policy_url"),
        privacyUrl: v("consent.privacy_url"),
        functionalEnabled: bool("consent.functional_enabled", false),
        analyticsEnabled: bool("consent.analytics_enabled", true),
        marketingEnabled: bool("consent.marketing_enabled", true),
        revision: v("consent.revision") || "1",
        bypassActive: tracking.bypassConsent,
      }}
    />
  );
}
