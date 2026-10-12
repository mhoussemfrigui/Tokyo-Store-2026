"use client";

import { products as catalog, type Product } from "@/storefront/lib/catalog";
import { isOrderable } from "@/storefront/lib/productMeta";
import { TabbedProducts, type ProductTab } from "@/storefront/components/storefront/tabbed-products";

/** "iPhone 17 Pro Max 2 To - Orange cosmique" -> 17 */
function generationOf(p: Product): number | null {
  const m = p.title.match(/iPhone\s*(\d{1,2})/i);
  return m ? Number(m[1]) : null;
}

/**
 * "iPhone 18 Pro Max 256Go SIM - Noir" -> "iPhone 18 Pro Max". A generation
 * ships as a dozen storage/colour variants, so the overview tab keys on the
 * model and shows each one once — otherwise ten cards of the same two phones
 * in four colours crowd out every other generation.
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

function buildTabs(category: string): ProductTab[] {
  /* Newest generation first, sellable (in stock or pre-order) ahead of rupture. */
  const pool = catalog
    .filter((p) => p.category === category)
    .sort((a, b) => {
      const stock = Number(isOrderable(b)) - Number(isOrderable(a));
      if (stock !== 0) return stock;
      return (generationOf(b) ?? 0) - (generationOf(a) ?? 0);
    });

  /* Generations that actually have products, oldest to newest: 11, 12, 13… */
  const generations = [
    ...new Set(pool.map(generationOf).filter((g): g is number => g !== null)),
  ].sort((a, b) => a - b);

  return [
    { label: "Tout", resolve: () => oneCardPerModel(pool) },
    ...generations.map((g) => ({
      label: `iPhone ${g}`,
      resolve: () => pool.filter((p) => generationOf(p) === g),
    })),
  ];
}

const VARIANTS = {
  neufs: {
    tabs: buildTabs("iphones-neufs"),
    eyebrow: "Apple · Neufs scellés, garantie 12 mois",
    title: "Trouvez votre iPhone neuf",
    viewAllHref: "/iphones-neufs",
  },
  occasion: {
    tabs: buildTabs("iphones-d-occasion"),
    eyebrow: "Reconditionnés certifiés · Testés sur 40 points",
    title: "Trouvez votre iPhone d'occasion",
    viewAllHref: "/iphones-d-occasion",
  },
} as const;

export function IphoneTabs({ variant }: { variant: keyof typeof VARIANTS }) {
  const { tabs, eyebrow, title, viewAllHref } = VARIANTS[variant];
  return <TabbedProducts eyebrow={eyebrow} title={title} tabs={tabs} viewAllHref={viewAllHref} />;
}
