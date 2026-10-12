import "server-only";

import { bannerQueries } from "@/modules/cms/banner";
import { trustBadgeService } from "@/modules/cms/trust_badge/service";
import { findMediaByIds } from "@/modules/media/queries";
import { getObjectBytes } from "@/modules/media/storage";
import { resolveMediaUrl, resolveEmailMediaUrl, resolveMediaAlt } from "@/modules/media/url-resolver";
import { getSettingsMap } from "@/modules/cms/setting/queries";
import { COLLECTION_SLUGS } from "@/lib/pages/collection-slugs";
import { asBool } from "@/lib/cms/setting-coerce";
import { getMenu, buildNavTree, type NavItemNode } from "@/modules/cms/navigation/queries";
import { navigationService } from "@/modules/cms/navigation/service";
import {
  FOOTER_COLUMNS,
  MAISON_EXPLORE_DEFAULTS,
  MAISON_EXPLORE_MENU_KEY,
  footerColumnTitle,
} from "@/lib/cms/nav-menus";
import {
  admitNavRefs,
  hasCheckedNavRef,
  listDeadNavItems,
  pruneDeadNavItems,
  type LiveNavTargets,
} from "@/lib/cms/nav-link-liveness";
import { listCategories } from "@/lib/api/categories";
import { brandQueries } from "@/modules/catalog/brand";
import { pageService } from "@/modules/cms/page/service";
import { redirectQueries } from "@/modules/redirects";
import { isRedirectsEnabled } from "@/lib/redirects/config";
import { normalizeSourcePath } from "@/lib/redirects/normalize";
import { isBuildPhase } from "@/lib/cache/build-phase";
import { safeHref } from "@/lib/utils/safe-href";
import {
  coerceGridPosition,
  coerceStripTone,
  effectiveBannerButtons,
  type BannerButton,
  type GridPosition,
  type StripTone,
} from "@/lib/cms/banner-model";
import type { Subcategory } from "@/types/catalog";

/**
 * Storefront-facing CMS API.
 *
 * One module-crossing seam: this file (in `lib/api/`, infra layer) resolves
 * banner.image_media_id → media.url so individual page server components
 * don't each fan out into the media module. Pages call these helpers and
 * receive flat, render-ready shapes.
 *
 * DB outages degrade gracefully — every function returns `[]` / `{}` on
 * error so storefront pages render with fallback content instead of 500ing.
 */

export type HeroSlide = {
  id: string;
  eyebrow: string | null;
  title: string;
  subtitle: string | null;
  description: string | null;
  // The hero's CTAs are the `buttons` array below (which already back-compat-synthesises
  // the legacy cta_* / secondary_cta_* columns); the renderer reads only `buttons`, so no
  // separate ctaLabel/ctaHref/secondaryCta* fields are carried here.
  image: string | null;
  /** Médiathèque alt for the slide image (decorative `""` fallback at render). */
  imageAlt: string | null;
  /** Optional art-directed MOBILE visual (portrait crop). Null → the desktop
   *  `image` is used at every width. Resolved from banners.image_mobile_media_id. */
  imageMobile: string | null;
  /** Optional HOSTED video URL (muted/looped, `image` is the poster). Sanitised
   *  from banners.video_url; null → still image only. */
  video: string | null;
  /** false = pure image/video link, no text/button overlay (banners.show_text). */
  showText: boolean;
  /** Editable CTAs (design-chosen), resolved + sanitised from banners.buttons
   *  with a back-compat fallback to the legacy cta_* columns. */
  buttons: BannerButton[];
};

/**
 * Render-ready DTO used by the header strip / category grid / footer
 * placements. Lighter than HeroSlide — no secondary CTA or description.
 */
export type RenderableBanner = {
  id: string;
  eyebrow: string | null;
  title: string;
  subtitle: string | null;
  ctaLabel: string | null;
  ctaHref: string | null;
  image: string | null;
  /** Optional art-directed MOBILE crop (category_grid). Null → `image` at every width.
   *  Resolved from banners.image_mobile_media_id. */
  imageMobile: string | null;
  /** Médiathèque alt for the banner image (decorative `""` fallback at render). */
  imageAlt: string | null;
  /** In-grid cadence — appear after every N "Charger plus" blocks (category_grid). */
  afterLoadMoreCount: number;
  /** category_grid placement — above the listing / after the first load-more /
   *  every N rows (the cadence). Default 'after_rows'. */
  gridPosition: GridPosition;
  /** header_strip style: background tone, optional leading emoji, countdown to endAt. */
  stripTone: StripTone;
  stripIcon: string | null;
  showCountdown: boolean;
  /** Schedule end (ISO) — the header_strip countdown target; null → no countdown. */
  endAt: string | null;
};

export async function listHomeHeroSlides(): Promise<HeroSlide[]> {
  const banners = await bannerQueries.listHomeHeroSlides();
  if (banners.length === 0) return [];
  // Gather BOTH the desktop and the optional mobile media ids in one pass so the
  // whole carousel's imagery resolves in a single médiathèque round-trip.
  const mediaIds = banners
    .flatMap((b) => [b.image_media_id, b.image_mobile_media_id])
    .filter((id): id is string => Boolean(id));
  const mediaMap = await findMediaByIds(mediaIds);
  return banners.map((b) => {
    const m = b.image_media_id ? mediaMap.get(b.image_media_id) : undefined;
    const mMobile = b.image_mobile_media_id
      ? mediaMap.get(b.image_mobile_media_id)
      : undefined;
    return {
      id: b.id,
      eyebrow: b.eyebrow,
      title: b.title,
      subtitle: b.subtitle,
      description: b.description,
      image: resolveMediaUrl(m),
      imageAlt: resolveMediaAlt(m),
      imageMobile: resolveMediaUrl(mMobile),
      // Sanitised at the read seam (blocks javascript:) like every other banner URL.
      video: b.video_url ? safeHref(b.video_url) : null,
      showText: b.show_text,
      // The hero's CTAs — effectiveBannerButtons sanitises hrefs + back-compat-synthesises
      // the legacy cta_* / secondary_cta_* columns for a pre-editor banner.
      buttons: effectiveBannerButtons(b),
    };
  });
}

/**
 * Resolve a list of banners + their image media into the lightweight
 * `RenderableBanner` shape used by header-strip / category-grid / footer
 * placements. Used by the helpers below — exposed via callers' wrappers.
 */
async function toRenderable(
  banners: Awaited<ReturnType<typeof bannerQueries.listHomeHeroSlides>>,
): Promise<RenderableBanner[]> {
  if (banners.length === 0) return [];
  // Gather the desktop + optional mobile crop in one médiathèque round-trip (the grid
  // banner art-directs the mobile crop, mirroring the hero).
  const mediaIds = banners
    .flatMap((b) => [b.image_media_id, b.image_mobile_media_id])
    .filter((id): id is string => Boolean(id));
  const mediaMap = await findMediaByIds(mediaIds);
  return banners.map((b) => {
    const m = b.image_media_id ? mediaMap.get(b.image_media_id) : undefined;
    const mMobile = b.image_mobile_media_id ? mediaMap.get(b.image_mobile_media_id) : undefined;
    return {
      id: b.id,
      eyebrow: b.eyebrow,
      title: b.title,
      subtitle: b.subtitle,
      ctaLabel: b.cta_label,
      ctaHref: b.cta_href ? safeHref(b.cta_href) : null,
      image: resolveMediaUrl(m),
      imageMobile: resolveMediaUrl(mMobile),
      imageAlt: resolveMediaAlt(m),
      afterLoadMoreCount: b.after_load_more_count,
      gridPosition: coerceGridPosition(b.grid_position),
      stripTone: coerceStripTone(b.strip_tone),
      stripIcon: b.strip_icon,
      showCountdown: b.show_countdown,
      endAt: b.end_at?.toISOString() ?? null,
    };
  });
}

export async function listHeaderStripBanners(): Promise<RenderableBanner[]> {
  // Chain so the .catch guards BOTH the banner query AND toRenderable — awaiting
  // the query first (the previous form) let a query rejection escape the guard.
  return bannerQueries.listHeaderStripBanners().then(toRenderable).catch(() => []);
}

/**
 * In-grid (category_grid) banners for a specific listing — targeting-aware
 * (global, or by category / brand / filter attribute). Pass the listing context
 * so banners targeted at it are included alongside the global ones.
 */
export async function listCategoryGridBanners(
  opts: { categorySlugs?: string[]; brandSlug?: string | null; filterAttributeIds?: string[] } = {},
): Promise<RenderableBanner[]> {
  return bannerQueries.listGridBannersForListing(opts).then(toRenderable).catch(() => []);
}

export async function listFooterBanners(): Promise<RenderableBanner[]> {
  return bannerQueries.listFooterBanners().then(toRenderable).catch(() => []);
}

/**
 * The FULL raw settings map (cached) — for SERVER components only. It is NOT a
 * public view: it carries `mail.*_enc` / `payment.*` ciphertext and raw admin
 * tracking HTML. The (shop) layout needs the whole map server-side (consent,
 * tracking, nav labels, footer); never pass it as a prop to a client component
 * or serialise it into a JSON route — use the allow-listed subset from
 * lib/api/content.ts (`getContentBundle().settings`) or pick the few keys needed.
 */
export async function getAllSettingsServerOnly(): Promise<Record<string, string | null>> {
  return getSettingsMap();
}

/**
 * The ISSUER address for fiscal documents (facture / reçu / BL / transfert) and
 * transactional emails: the central HQ / registered address (`business.hq_address`,
 * « Identité & contact » → Informations légales) when set, else the primary retail
 * store address (`site.address`) as a fallback so a document always carries an
 * address. Returns `null` only when neither is configured. Never throws.
 */
export async function getIssuerAddress(): Promise<string | null> {
  try {
    const settings = await getSettingsMap();
    const hq = settings["business.hq_address"]?.trim();
    const store = settings["site.address"]?.trim();
    return hq || store || null;
  } catch {
    return null;
  }
}

/**
 * Resolve the admin-configured site logo (`site.logo_media_id`, médiathèque) to
 * a same-origin `/cdn/…` URL — mirrors the SEO OG image resolution. Returns
 * `null` when the setting is unset or the media row is missing, so every
 * consumer (header, footer, auth pages) falls back to the bundled static asset
 * instead of rendering a broken image. Never throws.
 */
export async function getSiteLogoUrl(): Promise<string | null> {
  try {
    const settings = await getSettingsMap();
    const id = settings["site.logo_media_id"]?.trim();
    if (!id) return null;
    const byId = await findMediaByIds([id]);
    return resolveMediaUrl(byId.get(id) ?? null);
  } catch {
    return null;
  }
}

/**
 * Email-safe variant of {@link getSiteLogoUrl}: resolves the same admin logo
 * (`site.logo_media_id`) to its broadly-compatible RASTER url (jpg/png → webp),
 * skipping the AVIF variant that several inbox clients (notably Gmail) don't
 * render — a transactional email's single `<img src>` can't fall back. Returns
 * `null` when unset/missing so the email degrades to the text wordmark. Never throws.
 */
export async function getEmailLogoUrl(): Promise<string | null> {
  try {
    const settings = await getSettingsMap();
    const id = settings["site.logo_media_id"]?.trim();
    if (!id) return null;
    const byId = await findMediaByIds([id]);
    return resolveEmailMediaUrl(byId.get(id) ?? null);
  } catch {
    return null;
  }
}

/**
 * Print-safe variant of {@link getSiteLogoUrl}: resolves the same admin logo
 * (`site.logo_media_id`, « Identité & contact ») but INLINES its bytes as a
 * base64 data URL. Printable documents (facture, bon de livraison, bon de
 * transfert) auto-print almost immediately on load and can't wait for a `/cdn`
 * image to finish fetching — so, exactly like the order QR codes they already
 * inline, the logo must travel in the HTML itself to show on the printout.
 *
 * Reads the PRIMARY variant (`storage_key` + `mime_type`), which keeps the
 * uploaded format (PNG/JPEG/SVG/WEBP) — all print-safe in a raw `<img>`, unlike
 * the AVIF display variant. Returns `null` (→ consumers fall back to the text
 * shop name) when unset, missing, oversized, or on any read error. Never throws.
 */
export async function getSiteLogoDataUrl(): Promise<string | null> {
  try {
    const settings = await getSettingsMap();
    const id = settings["site.logo_media_id"]?.trim();
    if (!id) return null;
    const row = (await findMediaByIds([id])).get(id) ?? null;
    if (!row?.storage_key) return null;
    const obj = await getObjectBytes(row.storage_key);
    if (!obj) return null;
    // Cap the inlined size so one oversized logo can't bloat every printed
    // document (the bytes are duplicated into each document's HTML).
    if (obj.body.byteLength > 1_500_000) return null;
    const mime = obj.contentType ?? row.mime_type ?? "image/png";
    return `data:${mime};base64,${obj.body.toString("base64")}`;
  } catch {
    return null;
  }
}


/**
 * Render-ready nav link. `icon` is a lucide registry key (see
 * `@/lib/links/promo-icons`) or null — renderers map it through PROMO_ICON_MAP
 * and render nothing when null (hide-when-unset).
 */
export type NavLink = {
  label: string;
  href: string;
  icon: string | null;
  /** Admin-configured "open in a new tab" — renders target="_blank". */
  newTab: boolean;
  /** Nested sub-items (admin parent_id nesting). Empty for a leaf. */
  children: NavLink[];
};

export type FooterColumn = {
  /** Stable menu key (footer-shop/…) — the render identity for keys + accordion
   *  open-state, so two columns an admin renamed to the same TITLE never collide. */
  key: string;
  title: string;
  links: NavLink[];
};

/**
 * Map a resolved nav node into the render-ready NavLink shape, preserving the
 * admin's "open in new tab" flag and any nested children (sub-items). Hidden
 * items (`is_visible = false`) are dropped at every level.
 */
function toNavLink(it: NavItemNode): NavLink {
  return {
    label: it.label,
    href: safeHref(it.resolvedHref),
    // Only surface a known registry key — an unknown/stale value renders as
    // no icon rather than a broken fallback.
    icon: it.icon?.trim() || null,
    newTab: it.open_in_new_tab,
    children: it.children.filter((c) => c.is_visible).map(toNavLink),
  };
}

/**
 * The storefront-visible category / brand slugs, read from the SAME cached sets
 * the header mega-menu renders (tag-busted on every catalog write, so
 * deactivating or deleting a target drops its menu links on the next request).
 * Categories follow the storefront rule: the row AND its whole ancestor chain
 * active (`listCategories` keeps only active nodes at every depth). `null` means
 * unknown (build phase with no DB, or a failed lookup): callers then keep every
 * link rather than blank a menu.
 */
export async function loadLiveNavTargets(): Promise<LiveNavTargets | null> {
  if (isBuildPhase()) return null;
  try {
    const [categories, brands, pageSlugs, settings] = await Promise.all([
      listCategories(),
      brandQueries.listActiveBrands(),
      pageService.listPublishedSlugs(),
      // Showcase visibility (pages.<slug>.visible) — a hidden showcase page 404s, so its
      // nav link is pruned. Fail-OPEN (treat all visible) on a read error so a settings
      // hiccup keeps every link rather than dropping the catalogue menu items.
      getSettingsMap().catch(() => ({}) as Record<string, string | null>),
    ]);
    const category = new Set<string>();
    const walk = (nodes: Subcategory[]) => {
      for (const n of nodes) {
        category.add(n.slug);
        walk(n.children ?? []);
      }
    };
    for (const c of categories) {
      category.add(c.slug);
      walk(c.subcategories);
    }
    return {
      category,
      brand: new Set(brands.map((b) => b.slug)),
      page: new Set(pageSlugs),
      system: new Set(COLLECTION_SLUGS.filter((s) => asBool(settings[`pages.${s}.visible`], true))),
    };
  } catch {
    return null;
  }
}

/**
 * Re-admit the dead-looking refs whose URL an ACTIVE redirect still serves.
 * `nav_items.internal_ref` is never rewritten on a slug rename, but the rename
 * 301 (`lib/redirects/auto-slug-redirect`) or an operator rule (Système →
 * Redirections) keeps the stored URL working — the /[slug] resolver consults it
 * first — so pruning it would drop a link that works. Usually there is no candidate (no query at all); otherwise
 * one indexed lookup per distinct URL. Redirects switched off ⇒ nothing is
 * re-admitted (the URL really 404s). A failed lookup keeps the link (unknown ⇒
 * never blank a menu, like `loadLiveNavTargets`).
 */
async function admitRedirectedNavRefs(
  trees: NavItemNode[][],
  live: LiveNavTargets,
): Promise<LiveNavTargets> {
  const dead = trees.flatMap((items) => listDeadNavItems(items, live));
  if (dead.length === 0 || !(await isRedirectsEnabled())) return live;
  const served = new Map<string, Promise<boolean>>();
  const isServed = (href: string) => {
    const src = normalizeSourcePath(href);
    if (!src) return Promise.resolve(false);
    let hit = served.get(src);
    if (!hit) {
      hit = redirectQueries.findActiveBySource(src).then(
        (row) => row !== null,
        () => true,
      );
      served.set(src, hit);
    }
    return hit;
  };
  const flags = await Promise.all(dead.map((it) => isServed(it.resolvedHref)));
  return admitNavRefs(live, dead.filter((_, i) => flags[i]));
}

/**
 * Drop menu items whose category / brand target is no longer on the storefront
 * (it would 404) — unless an active redirect still serves its
 * URL (a renamed slug). The live sets are loaded once per call, and only when
 * some tree actually holds such a ref.
 */
async function pruneDeadMenuLinks(trees: NavItemNode[][]): Promise<NavItemNode[][]> {
  if (!trees.some((items) => hasCheckedNavRef(items))) return trees;
  const loaded = await loadLiveNavTargets();
  const live = loaded && (await admitRedirectedNavRefs(trees, loaded));
  return trees.map((items) => pruneDeadNavItems(items, live));
}

/**
 * Read the three footer columns (fixed keys, see FOOTER_COLUMNS) from the
 * navigation module. A column's heading is its menu NAME (renamable in CMS →
 * Footer; built-in title when blank). A missing menu or one with no visible
 * item is skipped — with none configured this returns `[]` and the footer
 * renders no link column at all (there are no hardcoded default links). Links
 * to a deactivated / deleted category or brand are dropped (a column left with
 * none is skipped too).
 */
export async function listFooterColumns(): Promise<FooterColumn[]> {
  // One read for the menu rows (their name is the heading), then ONE batched read
  // for the items of every present column (not a getMenu — i.e. a findMenuByKey +
  // query — per column). listItemsForMenus returns hidden rows too, so filter to
  // visible before building each tree (getMenu's query is visible-only).
  const menus = await navigationService.listMenus();
  const byKey = new Map(menus.map((m) => [m.key, m]));
  const present = FOOTER_COLUMNS.flatMap((c) => {
    const menu = byKey.get(c.key);
    return menu ? [{ column: c, menu }] : [];
  });
  const itemsByMenu = await navigationService.listItemsForMenus(present.map((p) => p.menu.id));
  const trees = await pruneDeadMenuLinks(
    present.map(({ menu }) => buildNavTree((itemsByMenu.get(menu.id) ?? []).filter((it) => it.is_visible))),
  );
  const all = present.map(({ column, menu }, i): FooterColumn | null => {
    const items = trees[i];
    if (items.length === 0) return null;
    return {
      key: column.key,
      title: footerColumnTitle(menu.name, column.title),
      links: items.map(toNavLink),
    };
  });
  return all.filter((c): c is FooterColumn => c !== null);
}

/** One entry of the « Explorer la maison » index (render-ready, sanitised href). */
export type MaisonExploreLink = {
  label: string;
  /** The item's sub-title (nav_items.description); null → no hint line. */
  hint: string | null;
  href: string;
  newTab: boolean;
};

/** The « Explorer la maison » index at the foot of the Maison & legal pages. */
export type MaisonExploreNav = {
  /** Small line above the heading (menu description); null → none. */
  eyebrow: string | null;
  /** Heading (menu name). */
  title: string;
  /** Brand line under the heading — the `site.tagline` setting (Réglages site). */
  tagline: string;
  links: MaisonExploreLink[];
};

/** Tagline shown when `site.tagline` is unset. */
const MAISON_EXPLORE_TAGLINE_FALLBACK = "Chaque seconde est un souvenir.";

function maisonExploreDefaults(tagline = MAISON_EXPLORE_TAGLINE_FALLBACK): MaisonExploreNav {
  return {
    eyebrow: MAISON_EXPLORE_DEFAULTS.description,
    title: MAISON_EXPLORE_DEFAULTS.name,
    tagline,
    links: MAISON_EXPLORE_DEFAULTS.items.map((it) => ({
      label: it.label,
      hint: it.hint,
      href: it.href,
      newTab: false,
    })),
  };
}

/**
 * Read the « Explorer la maison » index (menu `maison-explore`, CMS → Footer):
 * eyebrow = menu description, title = menu name, links = its visible top-level
 * items in order (label + description as the hint), resolved like the footer
 * (internal targets → their URL, dead category / brand links dropped, hrefs
 * sanitised). A missing menu row or a DB error falls back to the
 * built-in defaults (the index is seeded at boot, so that is only a fresh /
 * degraded deploy); a present menu with no visible link returns no links and
 * the renderer hides the section — an admin who emptied it meant it. Never throws.
 */
export async function getMaisonExploreNav(): Promise<MaisonExploreNav> {
  if (isBuildPhase()) return maisonExploreDefaults();
  // Settings are a per-request cached read (shared with the layout).
  const tagline = await getSettingsMap()
    .then((s) => s["site.tagline"]?.trim() || MAISON_EXPLORE_TAGLINE_FALLBACK)
    .catch(() => MAISON_EXPLORE_TAGLINE_FALLBACK);
  try {
    const menu = await navigationService.findMenuByKey(MAISON_EXPLORE_MENU_KEY);
    if (!menu) return maisonExploreDefaults(tagline);
    const [items] = await pruneDeadMenuLinks([await getMenu(MAISON_EXPLORE_MENU_KEY)]);
    return {
      eyebrow: menu.description?.trim() || null,
      title: menu.name.trim() || MAISON_EXPLORE_DEFAULTS.name,
      tagline,
      links: items.map((it) => ({
        label: it.label,
        hint: it.description?.trim() || null,
        href: safeHref(it.resolvedHref),
        newTab: it.open_in_new_tab,
      })),
    };
  } catch {
    return maisonExploreDefaults(tagline);
  }
}

/**
 * Read the admin-configured "main" header menu (key `main`). The storefront
 * renders these as a secondary nav row in the header. Returns an empty array
 * when the menu is missing or has no items — the header then renders nothing
 * for this row (hide-when-unset). Links to a deactivated / deleted category or
 * brand are dropped. Never throws.
 */
export async function listMainMenu(): Promise<NavLink[]> {
  try {
    const [items] = await pruneDeadMenuLinks([await getMenu("main")]);
    return items.map(toNavLink);
  } catch {
    return [];
  }
}

/** Active trust badges (the global reassurance strip), ordered. The per-product
 *  buy-box gating (resolveBuyBoxBadges) is a render concern left to the head. */
export type RenderableTrustBadge = {
  id: string;
  kind: string | null;
  label: string;
  icon: string;
  visibility: string;
};

export async function listActiveTrustBadges(): Promise<RenderableTrustBadge[]> {
  const rows = await trustBadgeService.listActive();
  return rows.map((b) => ({
    id: b.id,
    kind: b.kind,
    label: b.label,
    icon: b.icon,
    visibility: b.visibility,
  }));
}
