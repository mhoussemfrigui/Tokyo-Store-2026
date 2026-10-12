"use client";

import {
  TabbedProducts,
  categoryTab as tab,
  universeTab,
  type ProductTab,
} from "@/storefront/components/storefront/tabbed-products";
import { products, slugify } from "@/storefront/lib/catalog";

/**
 * Home "Découvrez notre sélection" tabs — DATA-DRIVEN from the imported migration
 * catalogue, not a hand-curated list. Each tab is a real top-level category
 * (the first segment of every product's `product_type` path, e.g. "Univers Apple",
 * "Téléphonie", "Console Gaming"), ordered by how many products it holds, with
 * "Voir tout" pointing at that category's own listing (/univers-apple, …). This
 * follows the owner's rule: take the categories from the migration data and use
 * them, rather than matching the Tokyo-Store-UI demo tabs.
 *
 * Computed once at module load (the catalogue is a bundled, synchronous snapshot).
 * TabbedProducts drops any non-first tab that can't fill a row, so a thin universe
 * never renders a sparse strip.
 */
const MIN_FOR_TAB = 6;

function buildUniverseTabs(): ProductTab[] {
  const counts = new Map<string, number>();
  for (const p of products) {
    const top = (p.product_type ?? "").split(" / ")[0].trim();
    if (top) counts.set(top, (counts.get(top) ?? 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, n]) => n >= MIN_FOR_TAB)
    .sort((a, b) => b[1] - a[1])
    .map(([name]) => universeTab(name, name, `/${slugify(name)}`));
}

const tabs: ProductTab[] = [tab("Tout", null), ...buildUniverseTabs()];

export function CategoryTabs() {
  return (
    /* 32px under the hero on phones (owner decision), then the section rhythm. */
    <section className="pt-8 sm:pt-16 lg:pt-20">
      <div className="page-container">
        <TabbedProducts
          eyebrow="Tokyo Store · High-tech en Tunisie"
          title="Découvrez notre sélection"
          tabs={tabs}
          viewAllHref="/notre-selection"
        />
      </div>
    </section>
  );
}
