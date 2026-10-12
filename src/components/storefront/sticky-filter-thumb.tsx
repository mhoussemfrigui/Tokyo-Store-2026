"use client";

import { SlidersHorizontal, ChevronUp, X, Check } from "lucide-react";
import { useEffect, useState } from "react";

import { SORT_OPTIONS } from "@/lib/catalog/sort-options";

/**
 * Floating bottom-center filter/sort pill. A faithful CSS-only replica of the
 * tokyo-lovable `StickyFilterThumb` (bg-foreground/90 backdrop-blur rounded-full):
 *
 *   • desktop  → inline sort chips + a "Filtres" toggle + a scroll-to-top chevron
 *   • mobile   → a "Trier" button (opens a bottom sheet of sort options) and a
 *                "Filtres" button, lifted clear of the global bottom nav
 *
 * It is wired to the category page's EXISTING state via props — it owns NONE of
 * the catalogue data. The "Filtres" button simply toggles the category's own
 * filter panel (`onToggleFilters`); it never duplicates the facet UI. Sort chips
 * call `onSortChange` with a stable `SortValue`. The pill hides while the
 * document `<footer>` is on screen (IntersectionObserver) and, below lg, floats
 * above the global mobile bottom nav (its reserved BOTTOM_BAR_SPACE = 5.25rem)
 * so the opaque nav never covers it. All motion is CSS transitions —
 * no framer-motion.
 */
export type StickyFilterThumbProps = {
  /** Show the pill (the page passes `!barVisible` — i.e. the inline bar scrolled off). */
  visible: boolean;
  /** Current sort value (stable `SortValue`, e.g. "price_asc"). */
  sortValue: string;
  /** Pick a sort value. */
  onSortChange: (value: string) => void;
  /** Whether the category's own filter panel is open (drives the toggle's active look). */
  filtersOpen: boolean;
  /** Toggle the category's existing filter panel. */
  onToggleFilters: () => void;
};

export function StickyFilterThumb({
  visible,
  sortValue,
  onSortChange,
  filtersOpen,
  onToggleFilters,
}: StickyFilterThumbProps) {
  const [footerVisible, setFooterVisible] = useState(false);
  const [sortSheetOpen, setSortSheetOpen] = useState(false);

  // Hide the pill once the footer scrolls into view (it sits at the page bottom,
  // so the floating bar would otherwise overlap it).
  useEffect(() => {
    const footer = document.querySelector("footer");
    if (!footer) return;
    const observer = new IntersectionObserver(
      ([entry]) => setFooterVisible(entry.isIntersecting),
      { threshold: 0 },
    );
    observer.observe(footer);
    return () => observer.disconnect();
  }, []);

  const show = visible && !footerVisible;

  // Close the mobile sort sheet whenever the bar hides.
  useEffect(() => {
    if (!show) setSortSheetOpen(false);
  }, [show]);

  const currentSort = SORT_OPTIONS.find((o) => o.value === sortValue);

  // Rendering null when hidden keeps the bar out of the layout/tab order — the
  // slide-up itself is a CSS transition on the mounted bar via the `show` flag.
  if (!visible) return null;

  const scrollToTop = () => window.scrollTo({ top: 0, behavior: "smooth" });

  return (
    <>
      {/* Mobile sort bottom sheet (CSS fade + slide, no framer). */}
      <div
        className={`fixed inset-0 z-[70] flex flex-col justify-end transition-opacity duration-300 md:hidden ${
          sortSheetOpen ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
        aria-hidden={!sortSheetOpen}
      >
        <button
          type="button"
          aria-label="Fermer"
          className="absolute inset-0 bg-foreground/30 backdrop-blur-sm"
          onClick={() => setSortSheetOpen(false)}
        />
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Trier par"
          className={`relative rounded-t-2xl border-t border-border/20 bg-background px-5 pt-5 transition-transform duration-300 ease-[cubic-bezier(0.25,0.46,0.45,0.94)] ${
            sortSheetOpen ? "translate-y-0" : "translate-y-full"
          }`}
          style={{ paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 1rem)" }}
        >
          <div className="mx-auto mb-5 h-1 w-10 rounded-full bg-border/40" />
          <h3 className="mb-4 font-body text-xs uppercase tracking-[0.15em] text-foreground">
            Trier par
          </h3>
          <div className="space-y-1">
            {SORT_OPTIONS.map((option) => {
              const active = option.value === sortValue;
              return (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => {
                    onSortChange(option.value);
                    setSortSheetOpen(false);
                  }}
                  className={`flex w-full items-center justify-between rounded-xl px-4 py-3 text-left font-body text-sm tracking-wide transition-all duration-300 ${
                    active ? "bg-olive/[0.08] text-foreground" : "text-muted-foreground/60"
                  }`}
                >
                  <span>{option.label}</span>
                  {active && <Check className="h-4 w-4 text-olive" strokeWidth={2} />}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* Floating bar — slides up via translate/opacity (CSS transition).
          Below lg it lifts CLEAR of the global mobile bottom nav (Accueil /
          Favoris / Panier), whose reserved height is BOTTOM_BAR_SPACE = 5.25rem
          (+ safe-area) — otherwise the opaque nav covers it. On lg+ the nav is
          hidden, so it drops back to bottom-6. */}
      <div
        className={`fixed left-0 right-0 z-40 flex justify-center px-4 transition-all duration-[350ms] ease-[cubic-bezier(0.25,0.46,0.45,0.94)] bottom-[calc(5.25rem+env(safe-area-inset-bottom,0px)+0.5rem)] lg:bottom-6 ${
          show ? "translate-y-0 opacity-100" : "pointer-events-none translate-y-[60px] opacity-0"
        }`}
      >
        <div className="inline-flex items-center rounded-full bg-foreground/90 shadow-[0_8px_32px_-8px_hsl(var(--foreground)/0.4)] backdrop-blur-md">
          {/* Desktop: inline sort chips + Filtres toggle. */}
          <div className="hidden items-center gap-0.5 px-1.5 py-1.5 md:flex">
            {SORT_OPTIONS.map((option) => {
              const active = option.value === sortValue;
              return (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => onSortChange(option.value)}
                  className={`rounded-full px-3 py-1.5 font-body text-[0.55rem] uppercase tracking-[0.06em] transition-all duration-300 ${
                    active
                      ? "bg-background/15 text-background"
                      : "text-background/50 hover:bg-background/10 hover:text-background"
                  }`}
                >
                  {option.label}
                </button>
              );
            })}

            <div className="mx-1 h-4 w-px bg-background/15" />

            <button
              type="button"
              onClick={onToggleFilters}
              aria-expanded={filtersOpen}
              className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 font-body text-[0.55rem] uppercase tracking-[0.06em] transition-all duration-300 ${
                filtersOpen
                  ? "bg-background/15 text-background"
                  : "text-background/50 hover:bg-background/10 hover:text-background"
              }`}
            >
              {filtersOpen ? (
                <X className="h-3 w-3" strokeWidth={1.5} />
              ) : (
                <SlidersHorizontal className="h-3 w-3" strokeWidth={1.5} />
              )}
              <span>Filtres</span>
            </button>
          </div>

          {/* Mobile: Trier (bottom sheet) + Filtres (category panel) buttons. */}
          <div className="flex items-center gap-0 px-1.5 py-1.5 md:hidden">
            <button
              type="button"
              onClick={() => setSortSheetOpen(true)}
              className="flex items-center justify-center gap-1.5 rounded-full px-4 py-2 font-body text-[0.6rem] uppercase tracking-[0.06em] text-background/70 transition-all duration-200 active:bg-background/10"
            >
              <span>{currentSort?.label ?? "Trier"}</span>
            </button>

            <div className="h-4 w-px bg-background/15" />

            <button
              type="button"
              onClick={() => {
                setSortSheetOpen(false);
                onToggleFilters();
              }}
              aria-expanded={filtersOpen}
              className="flex items-center justify-center gap-1.5 rounded-full px-4 py-2 font-body text-[0.6rem] uppercase tracking-[0.06em] text-background/70 transition-all duration-200 active:bg-background/10"
            >
              <SlidersHorizontal className="h-3 w-3" strokeWidth={1.5} />
              <span>Filtres</span>
            </button>
          </div>

          {/* Divider + scroll-to-top. */}
          <div className="flex items-center py-1.5 pr-1.5">
            <div className="mx-0.5 h-4 w-px bg-background/15" />
            <button
              type="button"
              onClick={scrollToTop}
              className="rounded-full p-1.5 text-background/40 transition-all duration-300 hover:bg-background/10 hover:text-background"
              aria-label="Retour en haut"
            >
              <ChevronUp className="h-3.5 w-3.5" strokeWidth={1.5} />
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
