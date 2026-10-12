import type { Metadata } from "next";

import { requirePermission } from "@/lib/auth/session";
import { navigationService } from "@/modules/cms/navigation/service";
import { productQueries } from "@/modules/catalog/product";
import { findMediaByIds } from "@/modules/media/queries";
import { resolveMediaThumbUrl } from "@/modules/media/url-resolver";
import { listLinkTargets } from "@/lib/api/link-targets";
import { MAIN_NAV_MENU_KEY } from "@/lib/cms/nav-menus";
import { defaultNavRoots } from "@/lib/cms/nav-defaults";
import {
  parseNavDropdown,
  parseNavRootConfig,
  navDropdownMediaIds,
  navUid,
  DEFAULT_NAV_IMAGE_ASPECT,
  DEFAULT_NAV_BLOCK_SIZE,
  type NavBlock,
  type NavDropdown,
  type NavSlot,
} from "@/lib/cms/nav-composer-model";
import type { LinkKind } from "@/lib/links/link-target";
import { NavBuilder } from "./nav-builder";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Nav Menu" };

type ELink = { label: string; kind: LinkKind; value: string; icon: string | null; newTab: boolean };
type EBlock = ReturnType<typeof toEBlock>;
type EColumn = { _id: string; blocks: EBlock[] };

function linkKindValue(href: string | null, kind: string | null, ref: string | null): { kind: LinkKind; value: string } {
  if (href) return { kind: "url", value: href };
  if (kind) return { kind: kind as LinkKind, value: ref ?? "" };
  return { kind: "url", value: "" };
}

function toEBlock(b: NavBlock) {
  const base = {
    _id: navUid(),
    type: b.type,
    title: "title" in b ? (b.title ?? "") : "",
    links: [] as ELink[],
    display: "",
    limit: "",
    maxPerColumn: "",
    source: "",
    count: "",
    pins: [] as string[],
    categorySlug: "",
    categoryRef: "",
    mediaId: null as string | null,
    mediaMobileId: null as string | null,
    eyebrow: "",
    aspect: DEFAULT_NAV_IMAGE_ASPECT as string,
    size: DEFAULT_NAV_BLOCK_SIZE as string,
    linkKind: "url" as LinkKind,
    linkValue: "",
    showOnMobile: false,
  };
  const mpc = "maxPerColumn" in b && b.maxPerColumn != null ? String(b.maxPerColumn) : "";
  switch (b.type) {
    case "taxonomy":
      return { ...base, categorySlug: b.categorySlug ?? "", maxPerColumn: mpc };
    case "links":
      return {
        ...base,
        maxPerColumn: mpc,
        links: b.links.map((l) => {
          const lk = linkKindValue(l.href ?? null, l.kind ?? null, l.ref ?? null);
          return { label: l.label, kind: lk.kind, value: lk.value, icon: l.icon ?? null, newTab: l.newTab ?? false };
        }),
      };
    case "categories":
      return { ...base, maxPerColumn: mpc, limit: b.limit != null ? String(b.limit) : "" };
    case "brands":
      return { ...base, maxPerColumn: mpc, display: b.display, limit: b.limit != null ? String(b.limit) : "", size: b.size ?? DEFAULT_NAV_BLOCK_SIZE };
    case "products":
      return { ...base, source: b.source, count: String(b.count ?? 4), pins: b.pins ?? [], categoryRef: b.categoryRef ?? "", size: b.size ?? DEFAULT_NAV_BLOCK_SIZE };
    case "image": {
      const lk = linkKindValue(b.href ?? null, b.kind ?? null, b.ref ?? null);
      return {
        ...base,
        mediaId: b.mediaId ?? null,
        mediaMobileId: b.mediaMobileId ?? null,
        eyebrow: b.eyebrow ?? "",
        title: b.title ?? "",
        aspect: b.aspect ?? DEFAULT_NAV_IMAGE_ASPECT,
        size: b.size ?? DEFAULT_NAV_BLOCK_SIZE,
        linkKind: lk.kind,
        linkValue: lk.value,
        showOnMobile: b.showOnMobile ?? false,
      };
    }
    default:
      return base;
  }
}

function dropdownToColumns(d: NavDropdown | null): EColumn[] {
  return (d?.columns ?? []).map((col) => ({ _id: navUid(), blocks: col.blocks.map(toEBlock) }));
}

export default async function NavMenuAdminPage() {
  await requirePermission("navigation", "view");

  const [mainRow, targets, productRows] = await Promise.all([
    navigationService.findMenuByKey(MAIN_NAV_MENU_KEY),
    listLinkTargets(),
    productQueries.listPublishedProducts({ limit: 100 }).catch(() => []),
  ]);
  const items = mainRow ? await navigationService.listAllItemsForMenu(mainRow.id) : [];
  const topLevel = items.filter((it) => !it.parent_id).sort((a, b) => a.display_order - b.display_order);

  // Map the DB roots → the builder's editable shape; fall back to the defaults
  // (un-seeded store) so the builder is never empty.
  let roots;
  if (topLevel.length > 0) {
    roots = topLevel.map((it) => {
      const lk = linkKindValue(it.href, it.internal_kind, it.internal_ref);
      const cfg = parseNavRootConfig(it.config as Record<string, unknown> | null);
      return {
        _id: navUid(),
        label: it.label,
        linkKind: lk.kind,
        linkValue: lk.value,
        icon: it.icon,
        isVisible: it.is_visible,
        newTab: it.open_in_new_tab,
        slot: cfg.slot as NavSlot,
        blurb: cfg.blurb ?? "",
        accent: cfg.accent,
        hasDropdown: cfg.dropdown != null,
        mobileVisible: cfg.dropdown?.mobileVisible ?? true,
        columns: dropdownToColumns(cfg.dropdown),
      };
    });
  } else {
    roots = defaultNavRoots({ label: (_k, f) => f }).map((d) => {
      const lk = linkKindValue(d.kind ? null : d.href, d.kind, d.ref);
      return {
        _id: navUid(),
        label: d.label,
        linkKind: lk.kind,
        linkValue: lk.value,
        icon: d.icon,
        isVisible: true,
        newTab: false,
        slot: d.slot as NavSlot,
        blurb: d.blurb ?? "",
        accent: d.accent ?? false,
        hasDropdown: d.dropdown != null,
        mobileVisible: d.dropdown?.mobileVisible ?? true,
        columns: dropdownToColumns(d.dropdown),
      };
    });
  }

  // Pre-resolve thumbnails for the média already referenced in image blocks.
  const mediaIds = Array.from(
    new Set(
      topLevel.flatMap((it) => navDropdownMediaIds(parseNavDropdown(it.config as Record<string, unknown> | null))),
    ),
  );
  const mediaMap = mediaIds.length > 0 ? await findMediaByIds(mediaIds).catch(() => new Map()) : new Map();
  const mediaThumbs: Record<string, string> = {};
  for (const id of mediaIds) {
    const url = resolveMediaThumbUrl(mediaMap.get(id));
    if (url) mediaThumbs[id] = url;
  }

  return (
    <NavBuilder
      initialRoots={roots}
      targets={targets}
      productOptions={productRows.map((p) => ({ id: p.id, name: p.name }))}
      mediaThumbs={mediaThumbs}
    />
  );
}
