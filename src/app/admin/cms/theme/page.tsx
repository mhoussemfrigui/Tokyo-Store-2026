import type { Metadata } from "next";

import { requirePermission } from "@/lib/auth/session";
import { pickSettings } from "@/lib/settings/pick-settings";
import { getSettingsMap } from "@/modules/cms/setting/queries";
import { ThemePanel } from "./theme-panel";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Thème & design" };

export default async function CmsThemeAdmin() {
  await requirePermission("settings_theme", "view");
  // No `.catch`: a failed read must reach the admin error boundary (retry), not
  // render a blank form whose save would reset the theme + favicon/OG/logo.
  const s = await getSettingsMap();
  // Only the prefixes the panel reads — never the whole table into the client.
  const values: Record<string, string> = {};
  for (const [k, val] of Object.entries(pickSettings(s, ["theme.", "admin.theme."]))) {
    values[k] = val ?? "";
  }

  return (
    <div className="space-y-10">
      <ThemePanel values={values} />
    </div>
  );
}
