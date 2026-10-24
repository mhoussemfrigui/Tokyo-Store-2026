"use client";

import { isOrderable } from "@/storefront/lib/productMeta";
import type { Product } from "@/storefront/types/catalog";
import { TabbedProducts, type ProductTab } from "@/storefront/components/storefront/tabbed-products";

/** "iPhone 17 Pro Max 2 To - Orange cosmique" -> 17 */
function generationOf(p: Product): number | null {
  const m = p.title.match(/iPhone\s*(\d{1,2})/i);
  return m ? Number(m[1]) : null;
}

/**
 * "iPhone 18 Pro Max 256Go SIM - Noir" -> "iPhone 18 Pro Max". A generation
 * ships as a dozen storage/colour variants, so the overview tab keys on the
 * model and shows each one once.
 */
function familyOf(p: Product): string {
  return p.title
    .split(/\s\d+\s*(?:Go|To)\b/i)[0]
    .replace(/\s*e-?sim\s*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function oneCardPerModel(pool: Product[]): Product[] {
  const seen = new Set<string>();
  return pool.filter((p) => {
    const key = familyOf(p).toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Newest generation first, sellable (in stock or pre-order) ahead of rupture. */
function sortPool(pool: Product[]): Product[] {
  return [...pool].sort((a, b) => {
    const stock = Number(isOrderable(b)) - Number(isOrderable(a));
    if (stock !== 0) return stock;
    return (generationOf(b) ?? 0) - (generationOf(a) ?? 0);
  });
}

/** iPhone generations the shop sells. A generation with no live products is dropped
 *  automatically by TabbedProducts (it only keeps non-first tabs that fill a row). */
const GENERATIONS = [11, 12, 13, 14, 15, 16, 17, 18, 19, 20];

/** Tabs over ONE live category pool (the neufs / occasion category), filtered client-side
 *  by iPhone generation. The pool is fetched live by TabbedProducts via each tab's source. */
function buildTabs(category: string): ProductTab[] {
  const source = { categories: [category] };
  return [
    { label: "Tout", source, transform: (pool) => oneCardPerModel(sortPool(pool)) },
    ...GENERATIONS.map(
      (g): ProductTab => ({
        label: `iPhone ${g}`,
        source,
        transform: (pool) => sortPool(pool).filter((p) => generationOf(p) === g),
      }),
    ),
  ];
}

const VARIANTS = {
  neufs: {
    tabs: buildTabs("iphones-neufs"),
    eyebrow: "Apple · Neufs scellés, garantie constructeur",
    title: "Trouvez votre iPhone neuf",
    viewAllHref: "/iphones-neufs",
  },
  occasion: {
    tabs: buildTabs("iphones-d-occasion"),
    eyebrow: "Reconditionnés certifiés et testés",
    title: "Trouvez votre iPhone d'occasion",
    viewAllHref: "/iphones-d-occasion",
  },
} as const;

export function IphoneTabs({ variant }: { variant: keyof typeof VARIANTS }) {
  const { tabs, eyebrow, title, viewAllHref } = VARIANTS[variant];
  return <TabbedProducts eyebrow={eyebrow} title={title} tabs={tabs} viewAllHref={viewAllHref} />;
}
