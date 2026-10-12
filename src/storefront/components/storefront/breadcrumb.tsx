"use client";

import { useEffect, useRef, useState } from "react";

import Link from "next/link";
import { ChevronRight, Home } from "lucide-react";

import { cn } from "@/storefront/lib/utils";

export type Crumb = {
  label: string;
  /** Absolute path, e.g. "/c/iphone". Omit for the current page. */
  to?: string;
};

/* Every crumb is the reference's 32px chip, the Home crumb included. */
const CRUMB = "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3";
const CRUMB_TRAIL = "border border-border bg-background font-medium text-muted-foreground";
/* Edge fades for a trail wider than its column: the side with hidden crumbs
   fades out over 24px, so a cut chip reads as "more this way", not as clipped. */
const FADE = {
  end: "linear-gradient(to right, black calc(100% - 24px), transparent)",
  start: "linear-gradient(to right, transparent, black 24px)",
  both: "linear-gradient(to right, transparent, black 24px, black calc(100% - 24px), transparent)",
} as const;

/**
 * Tokyo Store breadcrumb: a trail of 32px capsule chips (hairline, muted,
 * crimson on hover) separated by quiet chevrons; the current page is the tinted
 * accent chip ("you are here"). On phones the current-page chip is dropped: the
 * page's h1 repeats it right below, and it is what used to get clipped. If the
 * trail still overflows its column it scrolls, with a fade on the hidden side.
 */
export function Breadcrumb({ items, className = "" }: { items: Crumb[]; className?: string }) {
  const ref = useRef<HTMLOListElement>(null);
  const [fade, setFade] = useState<keyof typeof FADE | null>(null);
  // Re-observe when the trail itself changes, not on every render (items is a
  // fresh array each time).
  const trail = items.map((i) => i.label).join(" / ");

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      const overflowing = el.scrollWidth > el.clientWidth + 1;
      const start = overflowing && el.scrollLeft > 1;
      const end = overflowing && el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
      setFade(start && end ? "both" : start ? "start" : end ? "end" : null);
    };
    update();
    // The chips change width when the web font swaps in without the ol itself
    // resizing, so observe them too.
    const ro = new ResizeObserver(update);
    ro.observe(el);
    for (const li of Array.from(el.children)) ro.observe(li);
    el.addEventListener("scroll", update, { passive: true });
    return () => {
      ro.disconnect();
      el.removeEventListener("scroll", update);
    };
  }, [trail]);

  const mask = fade ? FADE[fade] : undefined;

  return (
    /* flow-root keeps the ol's negative margins inside the nav (no collapse
       with the next block's margin), so the nav lays out at the chips' 32px. */
    <nav aria-label="Fil d'Ariane" className={cn("flow-root", className)}>
      {/* py-1.5 leaves room for the chips' 44px hit area inside the scroller,
          and -my-1.5 takes it back out of layout, so the trail sits on the
          envelope padding and its 4px grid (crumb → title = mt-4 = 16px, not
          22); -mx-1 px-1 likewise for the focus ring at the scroller's edges.
          2px gaps around the chevrons on phones (its glyph carries ~5px of
          side bearing) so Accueil › Apple › iPhones fits a 320px envelope. */}
      <ol
        ref={ref}
        style={mask ? { maskImage: mask, WebkitMaskImage: mask } : undefined}
        className="-mx-1 -my-1.5 flex items-center gap-0.5 overflow-x-auto no-scrollbar px-1 py-1.5 text-[13px] leading-none sm:gap-1.5"
      >
        {items.map((item, i) => {
          const last = i === items.length - 1;
          const isHome = i === 0;
          const content = (
            <>
              {isHome && <Home aria-hidden className="size-3.5 shrink-0" />}
              <span className="truncate">{item.label}</span>
            </>
          );
          return (
            <li
              key={`${item.label}-${i}`}
              className={cn(
                "flex min-w-0 shrink-0 items-center gap-0.5 sm:gap-1.5",
                last && items.length > 1 && "hidden sm:flex",
              )}
            >
              {i > 0 && (
                <ChevronRight aria-hidden className="size-3.5 shrink-0 text-muted-foreground/60" />
              )}
              {last ? (
                <span
                  aria-current="page"
                  className={cn(
                    CRUMB,
                    "min-w-0 max-w-[42ch] bg-primary/10 font-semibold text-primary-ink",
                  )}
                >
                  {content}
                </span>
              ) : item.to ? (
                <Link
                  href={item.to}
                  className={cn(
                    CRUMB,
                    CRUMB_TRAIL,
                    "hit-44 transition-colors duration-200 hover:border-primary/40 hover:text-primary",
                  )}
                >
                  {content}
                </Link>
              ) : (
                <span className={cn(CRUMB, CRUMB_TRAIL)}>{content}</span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
