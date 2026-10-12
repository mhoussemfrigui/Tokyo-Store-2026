import { safeHref } from "@/lib/utils/safe-href";
import { COLLECTION_SLUGS, COLLECTION_PAGE_LABELS } from "@/lib/pages/collection-slugs";

/**
 * Shared link-target model used by BOTH promo chips and navigation items so an
 * admin can point a link at a system/showcase page, a category, a brand, a CMS
 * page, or a manual URL — from one consistent picker.
 *
 * Storage shape (on the row): a manual `href` OR an internal `(kind, ref)` pair
 * where `ref` is the target's slug. `resolveLinkHref()` turns either form into a
 * concrete, render-safe URL. This module is intentionally ISOMORPHIC — it must
 * not import any `server-only` code, because the admin picker (a client
 * component) imports the metadata + types from here.
 */

export type LinkKind = "url" | "system" | "category" | "brand" | "page";

export const LINK_KINDS: readonly LinkKind[] = [
  "url",
  "system",
  "category",
  "brand",
  "page",
];

export const LINK_KIND_LABELS: Record<LinkKind, string> = {
  url: "Lien manuel (URL)",
  system: "Page vitrine",
  category: "Catégorie",
  brand: "Marque",
  page: "Page CMS",
};

export const LINK_KIND_OPTIONS = LINK_KINDS.map((value) => ({
  value,
  label: LINK_KIND_LABELS[value],
}));

/**
 * The system/showcase pages for the link picker — DERIVED from the single
 * source (`collection-slugs.ts`, isomorphic), so it can never drift from
 * COLLECTION_SLUGS / the reserved-route set.
 */
export const SYSTEM_PAGES: readonly { slug: string; label: string }[] = COLLECTION_SLUGS.map(
  (slug) => ({ slug, label: COLLECTION_PAGE_LABELS[slug] }),
);

export type LinkTargetInput = {
  href?: string | null;
  internalKind?: string | null;
  internalRef?: string | null;
};

/**
 * Resolve a stored link target to a concrete, render-safe href.
 *
 * Precedence: an explicit `href` (manual URL) wins; otherwise the internal
 * `(kind, ref)` pair is mapped to its route. Every entity — including brands —
 * shares the flat `/[slug]` namespace (the `[slug]` resolver handles brands;
 * `/brand/[slug]` redirects there). The ref is URL-encoded so a malformed slug
 * can never break out of the path.
 */
export function resolveLinkHref(input: LinkTargetInput): string {
  const href = input.href?.trim();
  if (href) return safeHref(href);

  const kind = input.internalKind?.trim();
  const ref = input.internalRef?.trim();
  if (kind && ref) {
    const slug = encodeURIComponent(ref);
    switch (kind) {
      case "brand":
      case "system":
      case "category":
      case "page":
      case "product": // legacy nav kind — still resolves to the flat namespace
        return `/${slug}`;
    }
  }
  return "#";
}

/**
 * Derive the admin picker's `(kind, value)` from a stored row. Internal kinds
 * no longer offered in the picker (e.g. legacy `product`) collapse to a manual
 * URL so existing items stay editable without surprising the admin.
 */
export function linkTargetFromRow(input: LinkTargetInput): { kind: LinkKind; value: string } {
  const kind = input.internalKind?.trim();
  const ref = input.internalRef?.trim();
  if (kind && ref) {
    if (
      kind === "system" ||
      kind === "category" ||
      kind === "brand" ||
      kind === "page"
    ) {
      return { kind, value: ref };
    }
    return { kind: "url", value: resolveLinkHref(input) };
  }
  return { kind: "url", value: input.href?.trim() ?? "" };
}

