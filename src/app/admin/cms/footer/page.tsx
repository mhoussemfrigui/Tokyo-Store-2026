import type { Metadata } from "next";

import { requirePermission } from "@/lib/auth/session";
import { permissionSetAllows, resolveUserPermissions } from "@/lib/rbac/authorize";
import { pickSettings } from "@/lib/settings/pick-settings";
import { navigationService } from "@/modules/cms/navigation/service";
import type { NavItemRow } from "@/modules/cms/navigation/schema";
import { bannerService } from "@/modules/cms/banner/service";
import { getSettingsMap } from "@/modules/cms/setting/queries";
import { listLinkTargets } from "@/lib/api/link-targets";
import {
  FOOTER_COLUMNS,
  MAISON_EXPLORE_DEFAULTS,
  MAISON_EXPLORE_MENU_KEY,
  footerColumnTitle,
} from "@/lib/cms/nav-menus";
import { effectiveBannerButtons } from "@/lib/cms/banner-model";
import { FooterPanel } from "./footer-panel";
import type { BannerFormInitial } from "@/components/admin/banner-form";

export const metadata: Metadata = { title: "Footer" };

/** Hydrate a nav item row into the shared editor's shape. */
function toEditorItem(it: NavItemRow) {
  return {
    id: it.id,
    parentId: it.parent_id,
    label: it.label,
    description: it.description,
    href: it.href,
    internalKind: it.internal_kind,
    internalRef: it.internal_ref,
    icon: it.icon,
    displayOrder: it.display_order,
    isVisible: it.is_visible,
    openInNewTab: it.open_in_new_tab,
  };
}

export default async function FooterAdminPage() {
  // The page is a navigation surface (footer columns / explore index / banner),
  // but the Contenu & apparence form edits `settings_site` identity data. Gate
  // the PAGE on navigation:view and the identity form on settings_site:view, so a
  // navigation-only editor manages the nav-owned parts without seeing or (vainly)
  // trying to save the site identity (whose save requires settings_site:update).
  const session = await requirePermission("navigation", "view");
  const perms = await resolveUserPermissions(session.user.id);
  const canEditIdentity = permissionSetAllows(perms, "settings_site", "view");

  const [menus, targets, footerRow, settingsMap] = await Promise.all([
    navigationService.listMenus(),
    listLinkTargets(),
    // The singleton `footer`-placement banner (any state), or null.
    bannerService.findAnyByPlacement("footer").catch(() => null),
    // STRICT read (no fail-soft): this pre-fills the footer content SAVE form, so
    // an empty map would blank site.*/social.* on the next save — fail closed.
    getSettingsMap(),
  ]);
  // Footer content + appearance pre-fill — ONLY the prefixes the form reads, run
  // through pickSettings (which also secret-strips), so the whole site_settings
  // table (secrets, promo codes, tracking scripts) never reaches the client. Empty
  // for a viewer without settings_site:view (the form is hidden for them).
  const settingsValues: Record<string, string> = {};
  if (canEditIdentity) {
    for (const [k, val] of Object.entries(
      pickSettings(settingsMap, ["site.", "social.", "storefront.footer."]),
    )) {
      settingsValues[k] = val ?? "";
    }
  }

  // Only the three fixed-key footer column menus belong here (the `main` header
  // menu lives on the Nav Menu page), listed in storefront order (shop →
  // support → society). A missing one is offered for one-click creation.
  const byKey = new Map(menus.map((m) => [m.key, m]));
  const footerMenus = FOOTER_COLUMNS.flatMap((c) => {
    const m = byKey.get(c.key);
    return m ? [{ row: m, fallbackTitle: c.title }] : [];
  });
  const missingColumns = FOOTER_COLUMNS.filter((c) => !byKey.has(c.key)).map((c) => ({
    key: c.key,
    title: c.title,
  }));
  // The « Explorer la maison » index (foot of the Maison & legal pages) — also a
  // fixed-key system menu, edited here next to the footer columns.
  const exploreRow = byKey.get(MAISON_EXPLORE_MENU_KEY) ?? null;
  const itemsByMenu = await navigationService.listItemsForMenus([
    ...footerMenus.map(({ row }) => row.id),
    ...(exploreRow ? [exploreRow.id] : []),
  ]);
  const menusWithItems = footerMenus.map(({ row: m, fallbackTitle }) => ({
    id: m.id,
    key: m.key,
    // Shown (and renamed) exactly as the storefront heading renders it.
    name: footerColumnTitle(m.name, fallbackTitle),
    description: m.description,
    items: (itemsByMenu.get(m.id) ?? []).map(toEditorItem),
  }));
  const exploreMenu = exploreRow
    ? {
        id: exploreRow.id,
        key: exploreRow.key,
        // Shown (and renamed) exactly as the storefront heading renders it.
        name: exploreRow.name.trim() || MAISON_EXPLORE_DEFAULTS.name,
        description: exploreRow.description,
        items: (itemsByMenu.get(exploreRow.id) ?? []).map(toEditorItem),
      }
    : null;

  const footerBanner: BannerFormInitial | null = footerRow
    ? {
        id: footerRow.id,
        placement: footerRow.placement,
        name: footerRow.name,
        eyebrow: footerRow.eyebrow,
        title: footerRow.title,
        subtitle: footerRow.subtitle,
        description: footerRow.description,
        ctaLabel: footerRow.cta_label,
        ctaHref: footerRow.cta_href,
        imageMediaId: footerRow.image_media_id,
        imageMobileMediaId: footerRow.image_mobile_media_id,
        videoUrl: footerRow.video_url,
        showText: footerRow.show_text,
        buttons: effectiveBannerButtons(footerRow),
        startAt: footerRow.start_at?.toISOString() ?? null,
        endAt: footerRow.end_at?.toISOString() ?? null,
        displayOrder: footerRow.display_order,
        isActive: footerRow.is_active,
        targetKind: footerRow.target_kind,
        targetRef: footerRow.target_ref,
        afterLoadMoreCount: footerRow.after_load_more_count,
        gridPosition: footerRow.grid_position,
        stripTone: footerRow.strip_tone,
        stripIcon: footerRow.strip_icon,
        showCountdown: footerRow.show_countdown,
      }
    : null;

  return (
    <FooterPanel
      menus={menusWithItems}
      missingColumns={missingColumns}
      exploreMenu={exploreMenu}
      targets={targets}
      footerBanner={footerBanner}
      bannerTargetOptions={{ categories: [], brands: [], filters: [] }}
      settingsValues={settingsValues}
      canEditIdentity={canEditIdentity}
    />
  );
}
