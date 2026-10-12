import { redirect } from "next/navigation";

/**
 * The mailing surface moved to the Marketing group at /admin/marketing/mailing
 * (now a multi-tab hub: provider, templates, automations, logs). This stub keeps
 * old bookmarks/links working. The panel components still live in
 * ./mailing-panel and are reused by the new hub.
 */
export default function LegacyMailingRedirect() {
  redirect("/admin/marketing/mailing");
}
