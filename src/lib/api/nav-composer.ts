import "server-only";

import { navigationService } from "@/modules/cms/navigation/service";
import { MAIN_NAV_MENU_KEY } from "@/lib/cms/nav-menus";
import { findMediaByIds } from "@/modules/media/queries";
import { resolveMediaUrl, resolveMediaAlt } from "@/modules/media/url-resolver";
import { resolveLinkHref } from "@/lib/links/link-target";
import { loadLiveNavTargets } from "@/lib/api/cms";
import { checkedNavKind, type LiveNavTargets } from "@/lib/cms/nav-link-liveness";
import { isRedirectsEnabled } from "@/lib/redirects/config";
import { normalizeSourcePath } from "@/lib/redirects/normalize";
import { redirectQueries } from "@/modules/redirects";
import { listProductsForSource } from "@/lib/api/products";
import type { ProductSource } from "@/lib/pages/block-model";
import {
  parseNavRootConfig,
  dropdownBlocks,
  taxonomySections,
  type NavBlock,
  type NavDropdown,
  type NavProductsBlock,
  type NavSlot,
  type NavTaxoNode,
  type ResolvedNavBlock,
  type ResolvedNavColumn,
  type ResolvedNavItem,
  type ResolvedNavRoot,
} from "@/lib/cms/nav-composer-model";
import { defaultNavRoots } from "@/lib/cms/nav-defaults";

/** Minimal catalog inputs the layout already has — decoupled from the DB rows. */
export type NavCatInput = { slug: string; name: string; icon?: string | null; iconMediaId?: string | null };
export type NavBrandInput = { slug: string; name: string; logoMediaId?: string | null };

type Deps = {
  categories: NavCatInput[];
  brands: NavBrandInput[];
  /** The live category TREE — used to expand a `taxonomy` block into a universe's
   *  sub-category sections. Omitted by callers that have no taxonomy blocks
   *  (the legacy header never seeds one); a taxonomy block then resolves empty. */
  taxonomyTree?: NavTaxoNode[];
};

/** A root to resolve: either a materialized nav_item or a default fallback root.
 *  `kind`/`ref` are the RAW internal target (null for a manual-href or default
 *  root) so the root's own link can be liveness-checked like its child links. */
type RootSeed = {
  key: string;
  label: string;
  href: string;
  icon: string | null;
  newTab: boolean;
  kind: string | null;
  ref: string | null;
  dropdown: NavDropdown | null;
  slot: NavSlot;
  blurb: string | null;
  accent: boolean;
};

const PRODUCT_SOURCE_BY_KIND: Record<string, ProductSource["mode"]> = {
  category: "category",
  new_arrivals: "new",
  best_sellers: "best_sellers",
  on_promotion: "on_promotion",
  pins: "manual",
};

/** A checkable link target (raw fields) — the shape liveness keys on. */
type LinkCand = { href: string | null; kind: string | null; ref: string | null };
const toFields = (c: LinkCand) => ({ href: c.href, internal_kind: c.kind, internal_ref: c.ref });
const refKey = (kind: string, ref: string) => `${kind}\u0000${ref}`;

/**
 * Build the storefront mega-menu roots (desktop + mobile) from the materialized
 * `main` menu + the live catalog/média — the data-driven replacement for the old
 * hardcoded `buildNavRoots`.
 *
 * The `main` menu is resolved by KEY → its uuid id first: `nav_items.menu_id` is
 * a uuid FK, so filtering it by the literal key would throw (and silently fall
 * back). ALL top-level items are loaded so a MATERIALIZED-but-all-hidden menu
 * (operator hid every root → render an empty header, their choice) is told apart
 * from a never-materialized one (→ the default roots). Every lookup fails OPEN
 * to the defaults, so a DB hiccup never blanks the header. Returns plain,
 * client-safe DTOs organised into columns.
 */
export async function getComposedNavRoots(
  deps: Deps,
  menuKey: string = MAIN_NAV_MENU_KEY,
): Promise<ResolvedNavRoot[]> {
  // No storefront-side nav.* label overrides any more (a seeded store edits
  // labels in the Nav Menu builder) — the default roots use their built-in label.
  const lbl = (_key: string, fallback: string) => fallback;

  // 1. Root seeds — the materialized menu's top-level items, or the defaults.
  let seeds: RootSeed[];
  const menu = await navigationService.findMenuByKey(menuKey).catch(() => null);
  const allItems = menu ? await navigationService.listAllItemsForMenu(menu.id).catch(() => []) : [];
  const allTopLevel = allItems.filter((it) => !it.parent_id);
  if (allTopLevel.length > 0) {
    // Materialized: render the VISIBLE top-level roots (possibly none → an empty
    // header; we do NOT fall back to defaults, that was the operator's edit).
    seeds = allTopLevel
      .filter((it) => it.is_visible)
      .map((it) => {
        const cfg = parseNavRootConfig(it.config as Record<string, unknown> | null);
        return {
          key: it.id,
          label: it.label,
          href: resolveLinkHref({ href: it.href, internalKind: it.internal_kind, internalRef: it.internal_ref }),
          icon: it.icon,
          newTab: it.open_in_new_tab,
          kind: it.internal_kind,
          ref: it.internal_ref,
          dropdown: cfg.dropdown,
          slot: cfg.slot,
          blurb: cfg.blurb,
          accent: cfg.accent,
        };
      });
  } else {
    seeds = defaultNavRoots({
      label: lbl,
    }).map((d) => ({
      key: d.slug,
      label: d.label,
      href: d.href,
      icon: d.icon,
      newTab: false,
      kind: d.kind ?? null,
      ref: d.ref ?? null,
      dropdown: d.dropdown,
      slot: d.slot,
      blurb: d.blurb ?? null,
      accent: d.accent ?? false,
    }));
  }

  // 1b. Index the live category tree by slug → a `taxonomy` block expands the
  //     node into the mega-menu's titled sub-category sections. Empty when no
  //     tree was passed (legacy header) — taxonomy blocks then resolve empty.
  const taxoIndex = new Map<string, NavTaxoNode>();
  (function indexTree(nodes?: NavTaxoNode[]) {
    for (const n of nodes ?? []) {
      taxoIndex.set(n.slug, n);
      indexTree(n.children);
    }
  })(deps.taxonomyTree);

  // 2. Collect every média id referenced across all dropdowns (image blocks +
  //    brand logos, each capped by the block's limit so we never over-fetch the
  //    whole catalog) → ONE batch resolve.
  const mediaIds = new Set<string>();
  for (const s of seeds) {
    for (const b of dropdownBlocks(s.dropdown)) {
      if (b.type === "image") {
        if (b.mediaId) mediaIds.add(b.mediaId);
        if (b.mediaMobileId) mediaIds.add(b.mediaMobileId);
      } else if (b.type === "brands" && b.display !== "titles") {
        for (const br of deps.brands.slice(0, b.limit ?? deps.brands.length)) if (br.logoMediaId) mediaIds.add(br.logoMediaId);
      }
    }
  }
  const mediaMap = mediaIds.size > 0 ? await findMediaByIds([...mediaIds]).catch(() => new Map()) : new Map();
  const mediaUrl = (id: string | null | undefined): string | null =>
    id ? resolveMediaUrl(mediaMap.get(id)) ?? null : null;

  // 3. Resolve every products block (async) up front, keyed by block identity.
  //    A block that resolves to ZERO products is left unset → resolveBlock drops
  //    it (hide-when-empty parity with categories/brands). A `category` source
  //    pulls from the block's own categoryRef, or — unset — the OWNING root's
  //    category target (a universe shows its own products with zero config).
  const productBlocks: { block: NavProductsBlock; rootCatRef: string | null }[] = [];
  for (const s of seeds) {
    const rootCatRef = s.kind === "category" ? s.ref : null;
    for (const b of dropdownBlocks(s.dropdown)) {
      if (b.type === "products") productBlocks.push({ block: b, rootCatRef });
    }
  }
  const productResults = new Map<NavBlock, ResolvedNavBlock>();
  await Promise.all(
    productBlocks.map(async ({ block: b, rootCatRef }) => {
      const mode = PRODUCT_SOURCE_BY_KIND[b.source] ?? "new";
      const catRef = b.source === "category" ? (b.categoryRef ?? rootCatRef ?? "") : "";
      if (b.source === "category" && !catRef) return; // no category to pull from → drop
      const source: ProductSource = {
        mode,
        ref: catRef,
        productIds: b.source === "pins" ? (b.pins ?? []) : [],
        windowDays: 30,
        promoStrategy: "both",
      };
      const count = Math.min(Math.max(b.count ?? 4, 1), 6);
      const products = await listProductsForSource(source, count).catch(() => []);
      const items = products.slice(0, count).map((p) => ({
        name: p.name,
        href: `/${p.slug}`,
        // Product.image is a médiathèque URL string (or the bundled placeholder
        // StaticImageData) — normalise to a plain URL for the client DTO.
        imageUrl: typeof p.image === "string" ? p.image : (p.image?.src ?? null),
        price: p.price,
        oldPrice: p.oldPrice ?? null,
      }));
      if (items.length > 0) productResults.set(b, { type: "products", title: b.title, size: b.size ?? "md", items });
    }),
  );

  // 3b. Dead-link pruning for every CUSTOM internal ref (category/brand/
  //     collection/page/system) — a root's own link, a links-block link, or an
  //     image-panel CTA whose target was deactivated/deleted after it was picked.
  //     Only loads the live sets when some ref is actually checkable (dynamic
  //     source blocks resolve from the live catalog already). A renamed slug an
  //     ACTIVE redirect still serves is re-admitted (parity with the footer, see
  //     cms.ts:admitRedirectedNavRefs). live=null (build phase / lookup error) ⇒
  //     keep everything, never blank the menu.
  const candidates: LinkCand[] = [];
  for (const s of seeds) {
    candidates.push({ href: s.kind ? null : s.href, kind: s.kind, ref: s.ref });
    for (const b of dropdownBlocks(s.dropdown)) {
      if (b.type === "links") for (const l of b.links) candidates.push({ href: l.href ?? null, kind: l.kind ?? null, ref: l.ref ?? null });
      else if (b.type === "image") candidates.push({ href: b.href ?? null, kind: b.kind ?? null, ref: b.ref ?? null });
    }
  }
  const checkable = candidates.filter((c) => checkedNavKind(toFields(c)) !== null);
  const live: LiveNavTargets | null = checkable.length > 0 ? await loadLiveNavTargets() : null;
  const admitted = new Set<string>();
  if (live) {
    const dead = checkable.filter((c) => {
      const k = checkedNavKind(toFields(c))!;
      return !live[k].has((c.ref ?? "").trim());
    });
    if (dead.length > 0 && (await isRedirectsEnabled())) {
      const served = new Map<string, Promise<boolean>>();
      const isServed = (href: string) => {
        const src = normalizeSourcePath(href);
        if (!src) return Promise.resolve(false);
        let hit = served.get(src);
        if (!hit) {
          hit = redirectQueries.findActiveBySource(src).then((row) => row !== null, () => true);
          served.set(src, hit);
        }
        return hit;
      };
      const flags = await Promise.all(
        dead.map((c) => isServed(resolveLinkHref({ href: c.href, internalKind: c.kind, internalRef: c.ref }))),
      );
      dead.forEach((c, i) => {
        if (flags[i]) admitted.add(refKey(checkedNavKind(toFields(c))!, (c.ref ?? "").trim()));
      });
    }
  }
  const refLive = (c: LinkCand): boolean => {
    if (!live) return true;
    const k = checkedNavKind(toFields(c));
    if (!k) return true; // manual href / legacy kind — not liveness-checked
    const ref = (c.ref ?? "").trim();
    return live[k].has(ref) || admitted.has(refKey(k, ref));
  };

  // 4. Resolve one block into its render DTO (null → dropped). `rootCatRef` is the
  //    owning root's category target — a taxonomy/category block with no explicit
  //    slug inherits it (a universe auto-fills from its own category).
  const resolveBlock = (b: NavBlock, rootCatRef: string | null): ResolvedNavBlock | null => {
    switch (b.type) {
      case "taxonomy": {
        const slug = b.categorySlug ?? rootCatRef;
        const node = slug ? taxoIndex.get(slug) : undefined;
        if (!node) return null; // no tree / unknown slug → nothing to expand
        const sections = taxonomySections(node);
        return sections.length ? { type: "taxonomy", title: b.title, maxPerColumn: b.maxPerColumn, sections } : null;
      }
      case "links": {
        const items: ResolvedNavItem[] = b.links
          .filter((l) => refLive({ href: l.href ?? null, kind: l.kind ?? null, ref: l.ref ?? null }))
          .map((l) => ({
            label: l.label,
            href: resolveLinkHref({ href: l.href, internalKind: l.kind, internalRef: l.ref }),
            icon: l.icon ?? null,
            newTab: l.newTab,
          }));
        return items.length ? { type: "links", title: b.title, maxPerColumn: b.maxPerColumn, items } : null;
      }
      case "categories": {
        const items = deps.categories
          .slice(0, b.limit ?? deps.categories.length)
          .map((c) => ({ label: c.name, href: `/${c.slug}`, icon: c.icon ?? null }));
        return items.length ? { type: "categories", title: b.title, maxPerColumn: b.maxPerColumn, items } : null;
      }
      case "brands": {
        const items: ResolvedNavItem[] = deps.brands.slice(0, b.limit ?? deps.brands.length).map((br) => ({
          label: br.name,
          href: `/${br.slug}`,
          imageUrl: b.display !== "titles" ? mediaUrl(br.logoMediaId) : null,
        }));
        return items.length ? { type: "brands", title: b.title, display: b.display, maxPerColumn: b.maxPerColumn, size: b.size ?? "md", items } : null;
      }
      case "products":
        return productResults.get(b) ?? null;
      case "image": {
        const url = mediaUrl(b.mediaId);
        if (!url) return null; // no image set → nothing to show
        // A dead internal CTA falls back to the root link (href "#" → render uses
        // the root), so a deleted target never 404s from the featured panel.
        const ctaLive = refLive({ href: b.href ?? null, kind: b.kind ?? null, ref: b.ref ?? null });
        return {
          type: "image",
          imageUrl: url,
          imageMobileUrl: mediaUrl(b.mediaMobileId),
          imageAlt: resolveMediaAlt(mediaMap.get(b.mediaId!)) ?? b.title ?? "",
          eyebrow: b.eyebrow,
          title: b.title,
          href: ctaLive ? resolveLinkHref({ href: b.href, internalKind: b.kind, internalRef: b.ref }) || "#" : "#",
          aspect: b.aspect ?? "portrait",
          size: b.size ?? "md",
          showOnMobile: b.showOnMobile ?? false,
        };
      }
      default:
        return null;
    }
  };

  const resolved: ResolvedNavRoot[] = [];
  for (const s of seeds) {
    // Prune a materialized root whose OWN internal ref is dead (and not redirect-
    // served) — a top-level link to a deleted category/collection, exactly as a
    // dead child link is dropped. Manual-href + default roots have kind=null and
    // are never pruned here.
    if (!refLive({ href: s.kind ? null : s.href, kind: s.kind, ref: s.ref })) continue;
    const rootCatRef = s.kind === "category" ? s.ref : null;
    const columns: ResolvedNavColumn[] = (s.dropdown?.columns ?? [])
      .map((col) => ({
        blocks: col.blocks.map((b) => resolveBlock(b, rootCatRef)).filter((b): b is ResolvedNavBlock => b !== null),
      }))
      .filter((col) => col.blocks.length > 0);
    // Hide-when-empty parity: a root that DECLARED a dropdown but whose columns
    // all resolved to nothing (e.g. a Marques root with zero active brands, or a
    // products block with zero products) is dropped entirely — exactly as the old
    // buildNavRoots omitted an empty dynamic root. A plain-link root (no dropdown
    // config) is always kept.
    if (s.dropdown && columns.length === 0) continue;
    resolved.push({
      key: s.key,
      label: s.label,
      href: s.href,
      icon: s.icon,
      newTab: s.newTab,
      mobileVisible: s.dropdown?.mobileVisible ?? true,
      slot: s.slot,
      blurb: s.blurb,
      accent: s.accent,
      columns,
    });
  }
  return resolved;
}
