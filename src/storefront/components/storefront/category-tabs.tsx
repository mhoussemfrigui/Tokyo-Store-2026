"use client";

import { useEffect, useState } from "react";

import {
  TabbedProducts,
  universeTab,
  type ProductTab,
} from "@/storefront/components/storefront/tabbed-products";
import { SectionHeading } from "@/storefront/components/storefront/section-heading";

/**
 * Home "Découvrez notre sélection" tabs — DATA-DRIVEN from the LIVE taxonomy
 * (/api/store/categories → catalogSource, Postgres), not a bundled snapshot. Each tab is
 * a real top-level (root) category, ordered by how many products it holds, with "Voir tout"
 * pointing at that category's own listing. Each tab's products are then fetched live by
 * TabbedProducts. A thin universe (under one row) is dropped by TabbedProducts.
 */
type RootCategory = { slug: string; label: string; count: number };
const MIN_FOR_TAB = 6;

function Skeleton() {
  return (
    <div>
      <SectionHeading eyebrow="Tokyo Store · High-tech en Tunisie" title="Découvrez notre sélection" />
      <div
        aria-hidden
        className="mt-6 grid grid-cols-2 gap-3 sm:mt-6 sm:grid-cols-3 sm:gap-5 lg:grid-cols-5 lg:gap-6 2xl:grid-cols-6"
      >
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="aspect-[4/5] animate-pulse rounded-2xl bg-secondary" />
        ))}
      </div>
    </div>
  );
}

export function CategoryTabs() {
  const [tabs, setTabs] = useState<ProductTab[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    const ctrl = new AbortController();
    fetch("/api/store/categories", { signal: ctrl.signal })
      .then((r) => (r.ok ? r.json() : { categories: [] }))
      .then((d: { categories?: RootCategory[] }) => {
        if (cancelled) return;
        setTabs(
          (d.categories ?? [])
            .filter((c) => c.count >= MIN_FOR_TAB)
            .sort((a, b) => b.count - a.count)
            .map((c) => universeTab(c.label, c.slug, `/${c.slug}`)),
        );
      })
      .catch(() => {
        if (!cancelled) setTabs([]);
      });
    return () => {
      cancelled = true;
      ctrl.abort();
    };
  }, []);

  // No live universes resolved (empty store / transient error) → hide the section.
  if (tabs !== null && tabs.length === 0) return null;

  return (
    /* 32px under the hero on phones (owner decision), then the section rhythm. */
    <section className="pt-8 sm:pt-16 lg:pt-20">
      <div className="page-container">
        {tabs === null ? (
          <Skeleton />
        ) : (
          <TabbedProducts
            eyebrow="Tokyo Store · High-tech en Tunisie"
            title="Découvrez notre sélection"
            tabs={tabs}
            viewAllHref="/notre-selection"
            /* Each universe tab shows ~12 cards after de-dupe/interleave; fetch a
               bounded pool (not the whole ~900-product tree) so the home load
               isn't ~2 MB of JSON. 48 leaves headroom for de-dupe to fill 2 rows. */
            poolLimit={48}
          />
        )}
      </div>
    </section>
  );
}
