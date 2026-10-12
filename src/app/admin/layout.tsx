import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { getSession } from "@/lib/auth/session";
import { resolveAdminShellAccess } from "@/lib/rbac/authorize";
import { getAdminThemeConfig } from "@/lib/theme/admin-config";
import { getSiteLogoUrl } from "@/lib/api/cms";
import { AdminShell } from "./_components/admin-shell";
import { ClearStorefrontDark } from "./_components/clear-storefront-dark";

export const metadata: Metadata = {
  title: { default: "Admin", template: "%s · Admin" },
  description: "Tableau de bord administrateur Tokyo Store.",
  robots: { index: false, follow: false },
};

/**
 * Admin shell — applied to every /admin/* page.
 *
 * Gates the whole segment on RBAC admin-area access (any non-empty permission
 * set), 404ing everyone else so the routes stay undiscoverable. Existing
 * super-admins (wildcard) are unaffected. The resolved grant keys
 * (`grantedKeys`) are handed to the shell so the sidebar only shows sections
 * the user can open — `<id>:view`, or an item's own `visibleWhen` grants
 * (wildcard → all). Per-page/per-action `requirePermission` enforces the rest.
 */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session?.user) notFound();
  const { ok, grantedKeys } = await resolveAdminShellAccess(session.user.id);
  if (!ok) notFound();
  // Sidebar logo, most-specific first: an admin-only override
  // (admin.theme.logo_media_id) → the storefront's configured logo
  // (site.logo_media_id) → the ONE bundled brand mark the storefront header also
  // falls back to (public/tokyo-logo.png), which the browser-tab favicon now also
  // defaults to (see the root layout), so the sidebar logo and the tab icon are
  // the SAME mark. Both reads go through getSettingsMap (React-cache()d) so this
  // adds no extra round-trip over what the root layout already did.
  const [adminTheme, siteLogoUrl] = await Promise.all([
    getAdminThemeConfig().catch(() => null),
    getSiteLogoUrl().catch(() => null),
  ]);
  const logoUrl = adminTheme?.logoUrl ?? siteLogoUrl ?? "/tokyo-logo.png";

  return (
    <>
      {/* Admin is always light. The storefront dark mode toggles `dark` on the
          shared <html>; this client-only one-shot clears it so a dark
          storefront view can't bleed into the admin chrome via bfcache or a
          cross-segment link. (A real inline <script> rendered by a React
          component never runs on the client — hence the effect-based approach.) */}
      <ClearStorefrontDark />
      <AdminShell
        userName={session.user.name ?? session.user.email}
        userEmail={session.user.email}
        grantedKeys={grantedKeys}
        logoUrl={logoUrl}
      >
        {children}
      </AdminShell>
    </>
  );
}
