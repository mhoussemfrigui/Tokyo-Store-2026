"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowRight, ChevronLeft, ChevronRight } from "lucide-react";

import { cn } from "@/lib/utils";
import { SECTION_CONTAINER, SECTION_MAXW } from "@/lib/pages/block-model";
import { HeadRow, SmartLink } from "@/components/storefront/page/blocks/kit";
import type { Product } from "@/types/catalog";
import { ProductRailTrack, useRailScroll } from "./product-rail";
import { QUIET_LINK, QUIET_LINK_ARROW, QUIET_LINK_LABEL } from "./home-style";

/** The home track: the shared rail's gutters + snap, plus `-mt-1 pt-1` so a focused
 *  card's ring is never clipped at the top by the scroller. */
const HOME_TRACK =
  "-mt-1 flex snap-x snap-mandatory gap-4 overflow-x-auto scroll-smooth px-5 pb-2 pt-1 scroll-pl-5 [scrollbar-width:none] md:gap-6 md:px-8 md:scroll-pl-8 lg:px-12 lg:scroll-pl-12 [&::-webkit-scrollbar]:hidden";
/** Card widths that always leave a READABLE peek of the next card (≈44px at tablet,
 *  ≈60px on desktop) — the shared default left only a few-pixel sliver at 768 / 1024+. */
const HOME_ITEM = "w-[72%] shrink-0 snap-start sm:w-[44%] md:w-[29%] lg:w-[22.5%]";

/**
 * Homepage product rail — the shared kit head (eyebrow, two-tone title, 12-column head
 * row) over the scroll-snap `ProductRailTrack`, so the luxury ProductCard (cart / money /
 * wishlist / tracking wiring) is reused verbatim. Adds only what a shop front needs: a quiet
 * « Voir tout » continuation link and two bare chevrons that appear only when the track
 * actually overflows (disabled at either end). Only `ProductRailTrack` is shared — the
 * /collections magazine wraps it via CollectionRail, and the PDP complementary rail has its
 * own track; each surface supplies its own head, so there's no double heading.
 */
export function HomeRail({
  eyebrow,
  title,
  accent,
  accentStyle,
  subtitle,
  more,
  products,
  listName,
  align = "left",
}: {
  eyebrow?: string;
  title: string;
  accent?: string;
  accentStyle?: "gold" | "ink";
  subtitle?: string;
  more?: { href: string; label: string } | null;
  products: Product[];
  listName?: string;
  align?: "left" | "center";
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const scrollBy = useRailScroll(trackRef);
  const [scroll, setScroll] = useState({ start: true, end: false });

  useEffect(() => {
    const el = trackRef.current;
    if (!el) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const max = el.scrollWidth - el.clientWidth;
      const start = el.scrollLeft <= 4;
      const end = el.scrollLeft >= max - 4;
      // Only re-render when an end is reached / left — not on every scroll frame.
      setScroll((s) => (s.start === start && s.end === end ? s : { start, end }));
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    // The observer's first callback reports the initial overflow.
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", onScroll);
      ro.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [products.length]);

  if (products.length === 0) return null;
  const overflows = !(scroll.start && scroll.end);
  const center = align === "center";

  const controls =
    more || overflows ? (
      <div className={cn("flex items-center gap-6", center && "justify-center")}>
        {more && (
          <SmartLink href={more.href} className={QUIET_LINK}>
            <span className={QUIET_LINK_LABEL}>{more.label}</span>
            <ArrowRight className={QUIET_LINK_ARROW} strokeWidth={1.25} aria-hidden />
          </SmartLink>
        )}
        {overflows && (
          <div className={cn("hidden items-center gap-1 md:flex", !center && "ml-auto")}>
            <RailArrow dir={-1} disabled={scroll.start} onClick={() => scrollBy(-1)} />
            <RailArrow dir={1} disabled={scroll.end} onClick={() => scrollBy(1)} />
          </div>
        )}
      </div>
    ) : undefined;

  return (
    <div>
      <div className={SECTION_CONTAINER}>
        <HeadRow eyebrow={eyebrow} title={title} accent={accent} accentStyle={accentStyle} subtitle={subtitle} align={align} aside={controls} splitAt="md" />
      </div>
      {/* tk-native-tokens: the cards render exactly as on the product listing. */}
      <div className={cn("tk-native-tokens mx-auto w-full", SECTION_MAXW)}>
        <ProductRailTrack ref={trackRef} products={products} listName={listName} className={HOME_TRACK} itemClassName={HOME_ITEM} />
      </div>
    </div>
  );
}

/** `aria-disabled` (not `disabled`) at the track ends: a natively disabled button can't
 *  hold focus, so a keyboard user paging to the end would be dropped onto <body>. */
function RailArrow({ dir, disabled, onClick }: { dir: 1 | -1; disabled: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={disabled ? undefined : onClick}
      aria-disabled={disabled || undefined}
      aria-label={dir === -1 ? "Produits précédents" : "Produits suivants"}
      className="grid h-10 w-10 place-items-center rounded-full text-foreground/60 transition-colors duration-500 hover:text-foreground focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-foreground/80 aria-disabled:cursor-default aria-disabled:text-foreground/20 aria-disabled:hover:text-foreground/20"
    >
      {dir === -1 ? (
        <ChevronLeft className="h-4 w-4" strokeWidth={1.25} aria-hidden />
      ) : (
        <ChevronRight className="h-4 w-4" strokeWidth={1.25} aria-hidden />
      )}
    </button>
  );
}
