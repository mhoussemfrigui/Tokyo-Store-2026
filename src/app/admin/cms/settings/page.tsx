import type { Metadata } from "next";

import { requirePermission } from "@/lib/auth/session";
import { pickSettings } from "@/lib/settings/pick-settings";
import { getSettingsMap } from "@/modules/cms/setting/queries";
import { SiteSettingsPanel } from "./settings-panel";

export const metadata: Metadata = { title: "Réglages site" };

export default async function CmsSettingsAdmin() {
  await requirePermission("settings_site", "view");
  // No `.catch`: a failed read must reach the admin error boundary (retry), not
  // render a blank form whose save would wipe the site identity (incl. the
  // business.* legal identity every invoice prints live).
  const s = await getSettingsMap();
  // Only the prefixes the panel reads — never the whole table into the client.
  const values: Record<string, string> = {};
  for (const [k, val] of Object.entries(pickSettings(s, ["site.", "social.", "business."]))) {
    values[k] = val ?? "";
  }

  return (
    <div className="space-y-10">
      <SiteSettingsPanel values={values} />
    </div>
  );
}
