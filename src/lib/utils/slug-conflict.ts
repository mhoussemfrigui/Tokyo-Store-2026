import "server-only";

import { and, eq, isNotNull, isNull, ne } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { pages } from "@/modules/cms/page/schema";
import { categories } from "@/modules/catalog/category/schema";
import { products } from "@/modules/catalog/product/schema";
import { brands } from "@/modules/catalog/brand/schema";
import { isReservedSlug, RESERVED_ROUTES } from "@/lib/pages/reserved-routes";
import { findShadowingRedirect } from "@/lib/redirects/guard";

/**
 * Centralised slug conflict checker.
 *
 * Since URLs are now flat ( `/montres`, `/submariner`, `/about` —
 * all served from the same top-level namespace), a slug must be unique
 * across **every** entity that can sit on a public URL: CMS pages,
 * categories, products, brands. It must also avoid colliding with any
 * static route name owned by the storefront chrome (`/about`, `/blog`,
 * `/login`, etc. — those are file-based and take precedence over the
 * dynamic `/[slug]` resolver, so an admin slug that matches one of them
 * would be unreachable) and with an ACTIVE admin redirect on `/<slug>` (the
 * resolver issues it before the entity lookup — typically the automatic 301 a
 * renamed product / category / brand left on its old URL).
 *
 * Use this from every entity-create / entity-update workflow that controls
 * a public-URL slug. The function returns a structured result so the
 * caller can render a precise error ("'montres' is already used by a
 * category") instead of a generic "Slug déjà utilisé."
 *
 * Trade-off: checking 5 entities serially adds up to 5 round-trips per
 * write. Acceptable — admin writes are low-frequency.  If this ever
 * becomes a hot path, batch into a single UNION ALL.
 */

// The reserved first-level route names live in the ISOMORPHIC
// lib/pages/reserved-routes.ts (shared with the redirect-coverage helper and the
// pure drift test that diffs them against src/app — add a new static route there).
// Re-exported for existing importers.
export { RESERVED_ROUTES };

export type SlugConflictKind = "page" | "category" | "product" | "brand" | "reserved" | "redirect";

export type SlugCheckResult =
  | { ok: true }
  | { ok: false; kind: SlugConflictKind; message: string };

/**
 * Options for ignoring a specific row — used by update workflows so
 * "rename to its own current slug" doesn't false-positive against itself.
 */
export type SlugCheckOptions = {
  /**
   * Skip the conflict check for this kind + id. e.g. when updating page
   * `abc-123`, pass `{ excludeKind: 'page', excludeId: 'abc-123' }` so
   * the existing row of `pages` doesn't count.
   */
  excludeKind?: SlugConflictKind;
  excludeId?: string;
  /**
   * The kind of entity that will CLAIM the slug. `"page"` also reports a
   * SOFT-DELETED page still holding it: `pages_slug_unique` is a TOTAL unique
   * index (the system-pages bootstrap relies on the tombstone), so a deleted
   * page keeps its slug and the insert/rename would otherwise fail on a bare
   * 23505. Categories/products/brands free their slug on delete (partial
   * indexes), so for them a page tombstone is irrelevant.
   */
  forKind?: SlugConflictKind;
  /**
   * Other URLs the claimant will ALSO be served at, checked for an active
   * redirect like `/<slug>` — a sub-category's nested `/parent/<slug>`.
   */
  extraPaths?: string[];
  /**
   * The URL(s) the claimant lives at NOW (a rename). An active redirect on the
   * claimed URL whose chain leads back to one of them points at the claimant
   * itself — renaming back A→B→A over the automatic `/A → /B` — and is let
   * through: the update workflow deactivates it once the rename commits.
   */
  currentPaths?: string[];
};

const LABELS: Record<SlugConflictKind, string> = {
  page: "page",
  category: "catégorie",
  product: "produit",
  brand: "marque",
  reserved: "route système",
  redirect: "redirection",
};

/**
 * Check that a slug is available across CMS pages, categories, products,
 * brands, and reserved storefront routes. Returns a structured result.
 */
export async function checkSlugAvailability(
  rawSlug: string,
  options: SlugCheckOptions = {},
): Promise<SlugCheckResult> {
  const slug = rawSlug.trim().toLowerCase();
  if (!slug) {
    return { ok: false, kind: "reserved", message: "Slug vide." };
  }

  // 1. Reserved routes — cheap in-memory check; do this first.
  if (isReservedSlug(slug)) {
    return {
      ok: false,
      kind: "reserved",
      message: `« ${slug} » est un chemin réservé du site (${LABELS.reserved}). Choisissez un autre slug.`,
    };
  }

  // 2. Categories.
  const catWhere = options.excludeKind === "category" && options.excludeId
    ? and(eq(categories.slug, slug), ne(categories.id, options.excludeId), isNull(categories.deleted_at))
    : and(eq(categories.slug, slug), isNull(categories.deleted_at));
  const [cat] = await db.select({ id: categories.id, name: categories.name }).from(categories).where(catWhere).limit(1);
  if (cat) {
    return {
      ok: false,
      kind: "category",
      message: `« ${slug} » est déjà utilisé par la ${LABELS.category} « ${cat.name} ».`,
    };
  }

  // 3. Products.
  const prodWhere = options.excludeKind === "product" && options.excludeId
    ? and(eq(products.slug, slug), ne(products.id, options.excludeId), isNull(products.deleted_at))
    : and(eq(products.slug, slug), isNull(products.deleted_at));
  const [prod] = await db.select({ id: products.id, name: products.name }).from(products).where(prodWhere).limit(1);
  if (prod) {
    return {
      ok: false,
      kind: "product",
      message: `« ${slug} » est déjà utilisé par le ${LABELS.product} « ${prod.name} ».`,
    };
  }

  // 4. Brands.
  const brandWhere = options.excludeKind === "brand" && options.excludeId
    ? and(eq(brands.slug, slug), ne(brands.id, options.excludeId), isNull(brands.deleted_at))
    : and(eq(brands.slug, slug), isNull(brands.deleted_at));
  const [brand] = await db.select({ id: brands.id, name: brands.name }).from(brands).where(brandWhere).limit(1);
  if (brand) {
    return {
      ok: false,
      kind: "brand",
      message: `« ${slug} » est déjà utilisé par la ${LABELS.brand} « ${brand.name} ».`,
    };
  }

  // 5. CMS pages.
  const pageWhere = options.excludeKind === "page" && options.excludeId
    ? and(eq(pages.slug, slug), ne(pages.id, options.excludeId), isNull(pages.deleted_at))
    : and(eq(pages.slug, slug), isNull(pages.deleted_at));
  const [page] = await db.select({ id: pages.id, title: pages.title }).from(pages).where(pageWhere).limit(1);
  if (page) {
    return {
      ok: false,
      kind: "page",
      message: `« ${slug} » est déjà utilisé par la ${LABELS.page} « ${page.title} ».`,
    };
  }

  // 6. A DELETED page's tombstone (only matters when a page claims the slug —
  //    see SlugCheckOptions.forKind).
  if (options.forKind === "page") {
    const [tomb] = await db
      .select({ id: pages.id, title: pages.title })
      .from(pages)
      .where(and(eq(pages.slug, slug), isNotNull(pages.deleted_at)))
      .limit(1);
    if (tomb) {
      return {
        ok: false,
        kind: "page",
        message: `« ${slug} » reste réservé par la ${LABELS.page} supprimée « ${tomb.title} » : un slug de page supprimée ne peut pas être réutilisé. Choisissez un autre slug.`,
      };
    }
  }

  // 7. An ACTIVE redirect on the URL — resolveRedirect runs before the entity
  //    lookup, so the entity would be unreachable at its own URL (typically the
  //    automatic 301 a renamed entity left behind). Never silently dropped: the
  //    operator deactivates the rule or picks another slug.
  const shadow = await findShadowingRedirect([`/${slug}`, ...(options.extraPaths ?? [])], options.currentPaths);
  if (shadow) {
    return {
      ok: false,
      kind: "redirect",
      message: redirectShadowMessage(shadow.source),
    };
  }

  return { ok: true };
}

/**
 * French refusal for a slug whose URL carries an active redirect.
 */
export function redirectShadowMessage(source: string): string {
  return `Une ${LABELS.redirect} active existe pour ${source} — désactivez-la dans Système → Redirections, ou choisissez un autre slug.`;
}
