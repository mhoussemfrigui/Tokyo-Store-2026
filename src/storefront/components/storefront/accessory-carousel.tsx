"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import useEmblaCarousel from "embla-carousel-react";

import { isOrderable } from "@/storefront/lib/productMeta";
import type { Product } from "@/storefront/types/catalog";
import { useLiveProductsByCategory } from "@/storefront/lib/use-live-products";
import { CatalogProductCard } from "@/storefront/components/storefront/product-card";
import { RailArrow } from "@/storefront/components/storefront/rail-arrow";
import { SectionHeading, ViewAllLink } from "@/storefront/components/storefront/section-heading";
import { rhythm } from "@/storefront/components/storefront/ui-classes";
import { cn } from "@/storefront/lib/utils";

const ACCESSORY_CATEGORIES = [
  "accessoires-apple-officiels",
  "accessoires-officiels-protection",
  "accessoires-officiels-son",
  "accessoires-apple-cable",
  "accessoires-apple-adaptateur",
  "accessoires-apple-alimentation",
  "accessoires-apple-power-bank",
  "accessoires-apple-protection",
  "accessoires-pour-apple",
  "accessoires-magsafe",
  "accessoires-officiels-magsafe",
  "air-tag-et-accessoires",
  "apple-coques-et-etuis",
  "apple-films-de-protection",
  "apple-protection-pour-camera",
  "coques-et-etuis",
  "telephonie-protection",
  "telephonie-cables",
  "alimentation-et-cables",
  "chargeurs-adaptateurs",
  "power-bank",
  "accessoires-telephoniques",
  "accessoires-telephonie-ecouteurs",
  "accessoires-voiture",
  "accessoires-montres-connectees",
  "ecouteurs",
  "casques",
  "enceintes",
  "accessoires-audio",
  "accessoires-nintendo",
  "accessoires-playstation-5",
  "accessoires-playstation-4",
  "accessoires-xbox",
];

/**
 * Marques the shop leads with. Tier one are the household names; tier two are
 * the accessory brands that carry real recognition in Tunisia. The rail is
 * filled tier by tier, one product per brand per pass, so it reads as a curated
 * line-up rather than eight JBL boxes in a row.
 */
const BRAND_TIERS = [
  ["Apple", "Samsung", "Sony", "JBL", "Bose", "Nintendo", "Microsoft", "Nothing"],
  ["Belkin", "Spigen", "Green Lion", "Powerology", "Porodo", "Levelo", "HAVIT", "Redragon"],
];

const MAX_ITEMS = 14;

/**
 * The export carries no date field, so "latest" falls back to catalogue order —
 * the newest rows the shop exported come first within each brand.
 */
function pickAccessories(rawPool: Product[]): Product[] {
  const pool = rawPool.filter(isOrderable);

  const byBrand = new Map<string, Product[]>();
  for (const p of pool) {
    const brand = (p.brand || "").trim();
    if (!brand) continue;
    const list = byBrand.get(brand);
    if (list) list.push(p);
    else byBrand.set(brand, [p]);
  }

  const out: Product[] = [];
  for (const tier of BRAND_TIERS) {
    const queues = tier.map((b) => byBrand.get(b) ?? []).filter((q) => q.length > 0);
    for (let round = 0; out.length < MAX_ITEMS; round++) {
      const taken = queues.filter((q) => q[round]).map((q) => q[round]);
      if (taken.length === 0) break;
      for (const p of taken) {
        if (out.length >= MAX_ITEMS) break;
        out.push(p);
      }
    }
    if (out.length >= MAX_ITEMS) break;
  }
  return out;
}

export function AccessoryCarousel() {
  // Fetch the accessory categories LIVE (one request, comma-joined slugs), then run the
  // brand-tier line-up on the live pool. Renders nothing until products resolve.
  const { products: pool } = useLiveProductsByCategory(ACCESSORY_CATEGORIES.join(","));
  const accessories = useMemo(() => pickAccessories(pool), [pool]);

  const [emblaRef, emblaApi] = useEmblaCarousel({ align: "start", containScroll: "trimSnaps" });
  const [canPrev, setCanPrev] = useState(false);
  const [canNext, setCanNext] = useState(false);

  const scrollPrev = useCallback(() => emblaApi?.scrollPrev(), [emblaApi]);
  const scrollNext = useCallback(() => emblaApi?.scrollNext(), [emblaApi]);

  useEffect(() => {
    if (!emblaApi) return;
    const onSelect = () => {
      setCanPrev(emblaApi.canScrollPrev());
      setCanNext(emblaApi.canScrollNext());
    };
    emblaApi.on("select", onSelect);
    emblaApi.on("reInit", onSelect);
    onSelect();
    return () => {
      emblaApi.off("select", onSelect);
      emblaApi.off("reInit", onSelect);
    };
  }, [emblaApi]);

  if (accessories.length === 0) return null;

  return (
    <div>
      {/* Arrows sit with the heading rather than over the cards, so they never
          cover a product photo. Hidden on phones, which swipe instead. The
          RailArrow recipe's 44px on every pointer, like the product-page
          rails and the "Voir tout" chip beside them (chip.lg), so the
          cluster keeps one height. */}
      <SectionHeading
        eyebrow="Les marques qu'on aime · Nouveautés"
        title="Accessoires à la une"
        action={
          <>
            <RailArrow
              direction="prev"
              label="Accessoires précédents"
              onClick={scrollPrev}
              disabled={!canPrev}
              className="hidden sm:grid"
            />
            <RailArrow
              direction="next"
              label="Accessoires suivants"
              onClick={scrollNext}
              disabled={!canNext}
              className="hidden sm:grid"
            />
            <ViewAllLink href="/accessoires-apple-officiels" />
          </>
        }
      />

      <div className={rhythm.head}>
        {/* py-4 (cancelled by -my-4) is room inside the clip for the cards'
            shadow and focus ring; on phones the viewport also bleeds to the
            screen edges so the next card peeks past the gutter. */}
        <div
          ref={emblaRef}
          className="-my-4 overflow-hidden py-4 max-sm:mx-[calc(-1*var(--gutter))] max-sm:px-(--gutter)"
        >
          {/* Same card widths and gaps as the shelves' rail (phones) and grid
              (3 / 5 / 6 columns): the gap is a real CSS gap, so each basis
              is (100% − the gaps) / columns. */}
          <ul className={cn("flex touch-pan-y", rhythm.gap)}>
            {accessories.map((p) => (
              <li
                key={p.slug}
                className="flex min-w-0 flex-[0_0_44%] sm:flex-[0_0_calc((100%-2.5rem)/3)] lg:flex-[0_0_calc((100%-6rem)/5)] 2xl:flex-[0_0_calc((100%-7.5rem)/6)]"
              >
                <CatalogProductCard product={p} />
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
