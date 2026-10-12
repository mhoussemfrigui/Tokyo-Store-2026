import "server-only";

import { cache } from "react";

import { listCategories } from "@/lib/api/categories";
import { brandQueries } from "@/modules/catalog/brand";
import { getComposedNavRoots } from "@/lib/api/nav-composer";
import type { NavTaxoNode, ResolvedNavRoot } from "@/lib/cms/nav-composer-model";
import type { Category, Subcategory } from "@/types/catalog";

/** The active, nested category tree (listCategories) → the resolver's NavTaxoNode
 *  tree, so a `taxonomy` block expands a universe's live sub-categories. */
function subToTaxo(s: Subcategory): NavTaxoNode {
  return { slug: s.slug, name: s.name, children: (s.children ?? []).map(subToTaxo) };
}
function categoryToTaxo(c: Category): NavTaxoNode {
  return { slug: c.slug, name: c.name, children: (c.subcategories ?? []).map(subToTaxo) };
}

/**
 * The composed main-nav roots, REQUEST-CACHED. Builds the catalog deps from the
 * 'use cache' catalog readers, then composes the full mega-menu ONCE per request.
 * Both the `(shop)/(shell)` layout (which renders the header) and the home page
 * (which emits the SiteNavigationElement JSON-LD) read through this, so the
 * composition — média batch, product rails, dead-link pruning — runs a SINGLE time
 * instead of once per caller. Returns [] on any failure.
 */
export const getMainNavRoots = cache(async function getMainNavRoots(): Promise<ResolvedNavRoot[]> {
  try {
    const [categories, brands] = await Promise.all([
      listCategories().catch(() => []),
      brandQueries.listActiveBrands().catch(() => []),
    ]);
    return await getComposedNavRoots({
      categories: categories.map((c) => ({
        slug: c.slug,
        name: c.name,
        icon: c.icon ?? null,
        iconMediaId: c.iconMediaId ?? null,
      })),
      brands: brands.map((b) => ({ slug: b.slug, name: b.name, logoMediaId: b.logo_media_id ?? null })),
      taxonomyTree: categories.map(categoryToTaxo),
    });
  } catch {
    return [];
  }
});

/**
 * The main-nav roots as plain `{ name, url }` pairs — the data for the home page's
 * `SiteNavigationElement` JSON-LD. Derived from the request-cached getMainNavRoots
 * (SHARED with the header), so it's faithful to the rendered nav — same dead-link
 * pruning — and adds no extra composition work. The SiteNav builder absolutizes each
 * href. Returns [] when the nav is empty.
 */
export async function getMainNavItems(): Promise<Array<{ name: string; url: string }>> {
  const roots = await getMainNavRoots();
  return roots.map((r) => ({ name: r.label, url: r.href })).filter((r) => r.name && r.url);
}
