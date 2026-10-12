"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { MouseEvent } from "react";
import { Clapperboard, Heart, Home, Search, User, type LucideIcon } from "lucide-react";

import { useFavoriteCount } from "@/storefront/lib/favorites";
import { cn } from "@/storefront/lib/utils";

type Tab = {
  /** Kept for the accessible name (aria-label / sr-only) — no longer rendered as text. */
  label: string;
  Icon: LucideIcon;
  href?: string;
};

/* Recherche has no href: it is an action (it opens the search overlay), never
   a location, so it never takes the active state. */
const tabs: Tab[] = [
  { label: "Accueil", Icon: Home, href: "/" },
  { label: "Recherche", Icon: Search },
  { label: "Reels", Icon: Clapperboard, href: "/reels" },
  { label: "Favoris", Icon: Heart, href: "/favoris" },
  { label: "Compte", Icon: User, href: "/account" },
];

/* Full-cell targets (≈73×56 at 390). The focus ring is not drawn on the cell
   but on the capsule inside it (ringClass), which the cell's :focus-visible
   switches on. */
const cellClass =
  "group/cell relative flex h-full w-full items-center justify-center transition-[color,scale] duration-200 active:scale-95 focus-visible:outline-none";

/* Icon-only cell: a circular hit + focus area (48px) centered in the cell, with
   the active location tint circle sitting behind it. No labels any more. */
const ringClass =
  "flex h-12 w-12 items-center justify-center rounded-full transition-transform duration-200 group-focus-visible/cell:outline-2 group-focus-visible/cell:outline-offset-2 group-focus-visible/cell:outline-ring";

/**
 * Mobile tab bar: the top pill's twin. Same gutters (12 / 16px), height (56),
 * capsule, glass and resting shadow, so the two read as one family.
 *
 * - The fixed band is click-through; only the pill takes taps, so content
 *   showing in its see-through margins stays tappable (the header does the same).
 * - The active tab is derived from the route alone. Routes no tab owns (cart,
 *   checkout, listings, products) show no indicator and no aria-current.
 * - The current tab gets the reference's location tint (bg-primary/10 +
 *   primary-ink), not a solid bubble: solid crimson is kept for the page's CTA.
 * - The globals CSS slides the whole bar away ([data-bottom-nav]) while the
 *   mobile menu is open, and on short landscape phones while the cart /
 *   checkout order bar is shown (the bar takes this slot there), so no
 *   translate/opacity here.
 */
export function MobileBottomNav() {
  const pathname = usePathname();
  const favCount = useFavoriteCount();
  const active = tabs.findIndex((t) => t.href === pathname);

  const openSearch = (e: MouseEvent<HTMLButtonElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    // The overlay's circular reveal starts from the tapped tab.
    window.dispatchEvent(
      new CustomEvent("tokyo:open-search", {
        detail: { x: r.left + r.width / 2, y: r.top + r.height / 2 },
      }),
    );
  };

  return (
    <nav
      data-bottom-nav
      aria-label="Navigation principale"
      className="gutter-x pointer-events-none fixed inset-x-0 bottom-0 z-50 pt-2 md:hidden"
      style={{ paddingBottom: "calc(env(safe-area-inset-bottom) + 0.75rem)" }}
    >
      <div className="pointer-events-auto relative">
        <div
          aria-hidden
          className="absolute inset-0 rounded-full border border-border bg-background/95 shadow-float backdrop-blur-xl"
        />

        {/* Location tint. 6px inside the pill on every side, so its 22px radius
            is concentric with the pill's 28 (the header's icon discs sit on the
            same 6px inset). Mounted only on a tab's own route: coming from a
            route no tab owns, it appears in place instead of sliding across
            the bar from a stale position. */}
        {active !== -1 && (
          <span
            aria-hidden
            className="pointer-events-none absolute top-1/2 h-12 w-12 -translate-y-1/2 rounded-full bg-primary/10 transition-[left] duration-[420ms] ease-soft animate-in fade-in"
            style={{ left: `calc(${active * 20}% + 10% - 1.5rem)` }}
          />
        )}

        <ul className="relative grid h-14 grid-cols-5">
          {tabs.map((t, i) => {
            const isActive = i === active;
            const tone = isActive ? "text-primary-ink" : "text-graphite";
            const content = (
              <span className={ringClass}>
                <t.Icon
                  aria-hidden
                  className="size-[23px] transition-transform duration-200 group-active/cell:scale-90"
                  strokeWidth={isActive ? 2.4 : 1.9}
                  fill={isActive && t.Icon === Heart ? "currentColor" : "none"}
                />
              </span>
            );

            return (
              <li key={t.label} className="flex">
                {t.href ? (
                  <Link
                    href={t.href}
                    prefetch
                    aria-label={t.label}
                    aria-current={isActive ? "page" : undefined}
                    className={cn(cellClass, tone)}
                  >
                    {content}
                    {t.href === "/favoris" && favCount > 0 && (
                      <>
                        <span
                          aria-hidden
                          className="absolute top-1.5 left-[calc(50%+9px)] grid h-[18px] min-w-[18px] place-items-center rounded-full border-2 border-background bg-primary px-1 text-[10px] font-bold text-primary-foreground tabular-nums"
                        >
                          {favCount}
                        </span>
                        <span className="sr-only"> ({favCount})</span>
                      </>
                    )}
                  </Link>
                ) : (
                  <button
                    type="button"
                    aria-haspopup="dialog"
                    aria-label={t.label}
                    onClick={openSearch}
                    className={cn(cellClass, tone)}
                  >
                    {content}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </nav>
  );
}
