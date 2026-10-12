"use client";

import { forwardRef, useCallback } from "react";
import { ProductCard } from "@/components/product-card";
import type { Product } from "@/types/catalog";

/**
 * Headerless scroll-snap product track + its scroll helper — the reusable rail core.
 * Each consumer supplies its OWN header so there's no double heading: the homepage via
 * HomeRail (home-rail.tsx) and the /collections magazine via CollectionRail. Forwards its
 * ref so the parent can drive arrow scrolling. The luxury `ProductCard` (carousel variant)
 * is reused verbatim so cart / money / wishlist / tracking wiring stays intact.
 */
export const ProductRailTrack = forwardRef<
  HTMLDivElement,
  /** `itemClassName` overrides the per-card width (default below — PDP + /collections). */
  { products: Product[]; listName?: string; className?: string; itemClassName?: string }
>(function ProductRailTrack({ products, listName, className, itemClassName }, ref) {
  return (
    <div
      ref={ref}
      className={
        className ??
        // Left gutter matches the canonical SECTION_GUTTER (px-5 md:px-8 lg:px-12) so the
        // first card lines up with every other section's content edge. scroll-pl-* mirrors
        // the padding so snap-start doesn't auto-scroll the first card past the gutter
        // (without it the rail hugged the viewport edge). The track still free-scrolls right.
        "flex snap-x snap-mandatory gap-4 overflow-x-auto scroll-smooth px-5 pb-2 scroll-pl-5 [scrollbar-width:none] md:gap-6 md:px-8 md:scroll-pl-8 lg:px-12 lg:scroll-pl-12 [&::-webkit-scrollbar]:hidden"
      }
    >
      {products.map((p) => (
        <div
          key={p.slug}
          data-rail-item
          // Consistent, premium card sizing that always shows a clean partial "peek" of
          // the next card (never the cramped 5-across that cropped awkwardly): ~1.4 cards
          // on phones, ~2.3 on sm, ~3.2 on md, ~4.2 from lg up. Capped at ~4 so watch
          // cards stay large on wide screens.
          className={itemClassName ?? "w-[72%] shrink-0 snap-start sm:w-[44%] md:w-[31%] lg:w-[23.5%]"}
        >
          <ProductCard product={p} listName={listName} variant="carousel" />
        </div>
      ))}
    </div>
  );
});

/** Scroll a rail track by ~one card width (shared by ProductRail + CollectionRail). */
export function useRailScroll(trackRef: React.RefObject<HTMLDivElement | null>) {
  return useCallback(
    (dir: 1 | -1) => {
      const el = trackRef.current;
      if (!el) return;
      const first = el.querySelector<HTMLElement>("[data-rail-item]");
      const step = first ? first.offsetWidth + 24 : el.clientWidth * 0.8;
      el.scrollBy({ left: dir * step, behavior: "smooth" });
    },
    [trackRef],
  );
}

