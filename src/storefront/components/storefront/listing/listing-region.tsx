"use client";

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import {
  ArrowDownAZ,
  ArrowDownWideNarrow,
  ArrowUpDown,
  ArrowUpNarrowWide,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  SearchX,
  SlidersHorizontal,
  Sparkles,
  X,
} from "lucide-react";

import { CatalogProductCard } from "@/storefront/components/storefront/product-card";
import { FilterGroups } from "@/storefront/components/storefront/listing/filter-panel";
import { Sheet } from "@/storefront/components/storefront/listing/sheet";
import {
  SORT_LABELS,
  type ListingCols,
  type ListingSort,
  type ListingState,
} from "@/storefront/components/storefront/listing/use-listing";
import type { Product } from "@/storefront/types/catalog";
import { cn } from "@/storefront/lib/utils";

const SORT_ICON: Record<ListingSort, typeof ArrowUpDown> = {
  relevance: Sparkles,
  "price-asc": ArrowUpNarrowWide,
  "price-desc": ArrowDownWideNarrow,
  "name-asc": ArrowDownAZ,
};

/* ---------------- Sort menu (Normal V1 custom listbox) ---------------- */

function SortMenu({ sort, onPick }: { sort: ListingSort; onPick: (s: ListingSort) => void }) {
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onEsc);
    };
  }, [open]);

  return (
    <div ref={boxRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={cn(
          "flex h-11 items-center gap-2.5 rounded-full border-[1.5px] bg-surface-warm pl-4 pr-3.5 text-[14px] text-foreground transition-colors duration-200 hover:border-foreground/60",
          open ? "border-foreground bg-background" : "border-border",
        )}
      >
        <ArrowUpDown aria-hidden className="size-4 shrink-0" strokeWidth={2.2} />
        <span className="whitespace-nowrap text-muted-foreground">Trier par</span>
        <strong className="whitespace-nowrap">{SORT_LABELS[sort]}</strong>
        <ChevronDown
          aria-hidden
          className={cn("size-3.5 transition-transform duration-200", open && "rotate-180")}
          strokeWidth={2.4}
        />
      </button>
      <div
        role="listbox"
        aria-label="Trier les produits"
        className={cn(
          "absolute right-0 top-[calc(100%+8px)] z-30 w-[248px] origin-top-right rounded-[22px] border border-border bg-background p-1.5 shadow-overlay transition-[opacity,transform] duration-200",
          open ? "scale-100 opacity-100" : "pointer-events-none -translate-y-1.5 scale-95 opacity-0",
        )}
      >
        {(Object.keys(SORT_LABELS) as ListingSort[]).map((k) => {
          const Icon = SORT_ICON[k];
          const active = sort === k;
          return (
            <button
              key={k}
              type="button"
              role="option"
              aria-selected={active}
              onClick={() => {
                onPick(k);
                setOpen(false);
              }}
              className={cn(
                "flex h-[46px] w-full items-center justify-between gap-3 rounded-[16px] px-3.5 text-left text-[14px] transition-colors duration-150 hover:bg-secondary",
                active ? "bg-surface-warm font-bold" : "font-medium",
              )}
            >
              <span className="flex items-center gap-2.5">
                <Icon
                  aria-hidden
                  className={cn("size-4", active ? "text-primary" : "text-muted-foreground")}
                  strokeWidth={2.2}
                />
                {SORT_LABELS[k]}
              </span>
              {active && (
                <span className="grid size-[22px] place-items-center rounded-full bg-primary">
                  <Check aria-hidden className="size-3 text-primary-foreground" strokeWidth={3.4} />
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* ---------------- Density toggle (3 / 4 / 5 per row, desktop) ---------------- */

function DensityBars({ n }: { n: ListingCols }) {
  const widths = { 3: 4.67, 4: 3, 5: 2.4 }[n];
  const gap = { 3: 6.67, 4: 5, 5: 3.9 }[n];
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      {Array.from({ length: n }).map((_, i) => (
        <rect key={i} x={3 + i * gap} y="3" width={widths} height="18" rx="1.4" />
      ))}
    </svg>
  );
}

function DensityToggle({ cols, onChange }: { cols: ListingCols; onChange: (c: ListingCols) => void }) {
  return (
    <div
      role="radiogroup"
      aria-label="Produits par ligne"
      className="relative grid grid-cols-[44px_44px_44px] rounded-full bg-secondary p-[3px]"
    >
      <span
        aria-hidden
        className="absolute left-[3px] top-[3px] h-[38px] w-11 rounded-full bg-background shadow-island transition-transform duration-300 ease-[cubic-bezier(.3,1.3,.5,1)]"
        style={{ transform: `translateX(${(cols - 3) * 44}px)` }}
      />
      {([3, 4, 5] as ListingCols[]).map((n) => (
        <button
          key={n}
          type="button"
          role="radio"
          aria-checked={cols === n}
          aria-label={`${n} produits par ligne`}
          title={`${n} par ligne`}
          onClick={() => onChange(n)}
          className={cn(
            "relative grid h-[38px] place-items-center rounded-full transition-colors duration-200",
            cols === n ? "text-foreground" : "text-muted-foreground/70 hover:text-foreground",
          )}
        >
          <DensityBars n={n} />
        </button>
      ))}
    </div>
  );
}

/* ---------------- Pagination (Normal V1) ---------------- */

function pageList(page: number, total: number, around: number) {
  const out: (number | "…")[] = [];
  for (let i = 1; i <= total; i++) {
    if (i === 1 || i === total || Math.abs(i - page) <= around) out.push(i);
    else if (out[out.length - 1] !== "…") out.push("…");
  }
  return out;
}

function Pagination({
  page,
  totalPages,
  rangeFrom,
  rangeTo,
  total,
  onChange,
}: {
  page: number;
  totalPages: number;
  rangeFrom: number;
  rangeTo: number;
  total: number;
  onChange: (n: number) => void;
}) {
  const circle =
    "grid size-11 place-items-center rounded-full text-[18px] transition-colors duration-200 disabled:pointer-events-none disabled:opacity-35";
  const pages = (around: number) =>
    pageList(page, totalPages, around).map((p, i) =>
      p === "…" ? (
        <span key={`e-${i}`} aria-hidden className="px-1 text-muted-foreground">
          …
        </span>
      ) : (
        <button
          key={p}
          type="button"
          onClick={() => p !== page && onChange(p)}
          aria-label={`Page ${p}`}
          aria-current={p === page ? "page" : undefined}
          className={cn(
            "grid h-11 min-w-11 place-items-center rounded-full px-1.5 text-[14px] font-bold tabular-nums transition-colors duration-200",
            p === page
              ? "bg-foreground text-background"
              : "bg-secondary text-foreground hover:brightness-95",
          )}
        >
          {p}
        </button>
      ),
    );
  return (
    <nav
      aria-label="Pagination"
      className="mt-1.5 flex min-h-16 flex-wrap items-center justify-between gap-3 rounded-[24px] bg-background py-2 pl-5 pr-2"
    >
      <span className="text-[14px] text-muted-foreground">
        Produits{" "}
        <strong className="font-bold text-foreground tabular-nums">
          {rangeFrom}–{rangeTo}
        </strong>{" "}
        sur {total}
      </span>
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => onChange(page - 1)}
          disabled={page === 1}
          aria-label="Page précédente"
          className={cn(circle, "border border-border bg-background text-foreground hover:bg-secondary")}
        >
          <ChevronLeft aria-hidden className="size-4" strokeWidth={2.4} />
        </button>
        <div className="flex items-center gap-1 sm:hidden">{pages(0)}</div>
        <div className="hidden items-center gap-1 sm:flex">{pages(1)}</div>
        <button
          type="button"
          onClick={() => onChange(page + 1)}
          disabled={page === totalPages}
          aria-label="Page suivante"
          className={cn(circle, "bg-foreground text-background hover:brightness-125")}
        >
          <ChevronRight aria-hidden className="size-4" strokeWidth={2.4} />
        </button>
      </div>
    </nav>
  );
}

/* ---------------- Active-filter chips ---------------- */

function ActiveChips({
  chips,
  onReset,
}: {
  chips: ListingState["activeChips"];
  onReset: () => void;
}) {
  if (chips.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      {chips.map((c) => (
        <button
          key={c.key}
          type="button"
          onClick={c.onRemove}
          aria-label={`Retirer le filtre ${c.label}`}
          className="flex h-9 items-center gap-2 rounded-full bg-foreground py-0 pl-3.5 pr-2.5 text-[13px] font-semibold text-background"
        >
          {c.label}
          <span className="grid size-[18px] place-items-center rounded-full bg-background/20">
            <X aria-hidden className="size-2.5" strokeWidth={3} />
          </span>
        </button>
      ))}
      <button
        type="button"
        onClick={onReset}
        className="h-9 px-2.5 text-[13px] font-bold text-primary underline decoration-1 underline-offset-[3px]"
      >
        Tout effacer
      </button>
    </div>
  );
}

/* ---------------- The region ---------------- */

/**
 * The shared listing surface (Normal V1): a desktop filter rail / mobile filter
 * drawer, a toolbar (result count + sort + per-row density), active-filter chips,
 * the product grid, an empty state and pagination. Pass a `renderCard` to decorate
 * cards (e.g. search-term highlighting) and `emptyState` to override the no-match
 * copy; otherwise the standard `CatalogProductCard` + filtered-empty copy is used.
 */
export function ListingRegion({
  listing,
  renderCard,
  emptyState,
}: {
  listing: ListingState;
  renderCard?: (product: Product) => ReactNode;
  emptyState?: ReactNode;
}) {
  const {
    shown,
    count,
    totalPages,
    page,
    rangeFrom,
    rangeTo,
    cols,
    sort,
    activeChips,
    drawerOpen,
    resultsRef,
    gridRef,
    capsuleRef,
    setSort,
    setCols,
    goToPage,
    resetFilters,
    setDrawerOpen,
  } = listing;

  const hasResults = shown.length > 0;
  const resetBtn = cn(
    "h-8 rounded-full px-3 text-[13px] font-bold transition-colors duration-200",
    activeChips.length > 0
      ? "bg-primary/10 text-primary"
      : "bg-secondary text-muted-foreground",
  );

  return (
    <>
      <div ref={resultsRef} className="grid items-start gap-5 lg:grid-cols-[320px_minmax(0,1fr)]">
        {/* Desktop filter rail */}
        <aside
          aria-label="Filtres"
          className="hidden lg:sticky lg:top-(--sticky-top) lg:block lg:max-h-[calc(100dvh-var(--sticky-top)-1.5rem)] lg:overflow-y-auto lg:overscroll-contain"
        >
          <div className="rounded-[28px] bg-background px-6 py-1">
            <div className="flex h-[72px] items-center justify-between gap-3">
              <h2 className="text-[20px] font-extrabold tracking-[-0.02em] text-foreground">
                Filtres
              </h2>
              <button type="button" onClick={resetFilters} className={resetBtn}>
                Réinitialiser
              </button>
            </div>
            <FilterGroups listing={listing} />
            <div className="h-3" />
          </div>
        </aside>

        {/* Results column */}
        <div className="flex min-w-0 flex-col gap-3.5">
          {/* Toolbar */}
          <div
            ref={capsuleRef}
            className="flex min-h-16 flex-wrap items-center justify-between gap-2.5 rounded-[24px] bg-background py-2 pl-4 pr-2"
          >
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => setDrawerOpen(true)}
                aria-haspopup="dialog"
                aria-expanded={drawerOpen}
                className="flex h-11 items-center gap-2 rounded-full bg-foreground pl-3.5 pr-4 text-[14px] font-bold text-background lg:hidden"
              >
                <SlidersHorizontal aria-hidden className="size-4" strokeWidth={2.2} />
                Filtres
                {activeChips.length > 0 && (
                  <span className="grid h-5 min-w-5 place-items-center rounded-full bg-primary px-1.5 text-[11px] font-bold text-primary-foreground">
                    {activeChips.length}
                  </span>
                )}
              </button>
              <span className="text-[15px]">
                <strong className="font-bold tabular-nums text-foreground">{count}</strong>{" "}
                <span className="text-muted-foreground">{count === 1 ? "produit" : "produits"}</span>
              </span>
            </div>
            <div className="flex items-center gap-2">
              <SortMenu sort={sort} onPick={setSort} />
              <div className="hidden lg:block">
                <DensityToggle cols={cols} onChange={setCols} />
              </div>
            </div>
          </div>

          {/* Active chips */}
          {activeChips.length > 0 && <ActiveChips chips={activeChips} onReset={resetFilters} />}

          {/* Grid / empty */}
          {hasResults ? (
            <ul
              ref={gridRef}
              role="list"
              tabIndex={-1}
              aria-label={totalPages > 1 ? `Produits, page ${page} sur ${totalPages}` : "Produits"}
              style={{ "--cols": cols } as CSSProperties}
              className="grid grid-cols-2 gap-3.5 focus:outline-none sm:grid-cols-3 lg:[grid-template-columns:repeat(var(--cols),minmax(0,1fr))]"
            >
              {shown.map((p, i) => (
                <li key={`${p.slug}-${i}`}>{renderCard ? renderCard(p) : <CatalogProductCard product={p} />}</li>
              ))}
            </ul>
          ) : (
            (emptyState ?? (
              <div className="flex flex-col items-center gap-3.5 rounded-[28px] bg-background px-6 py-14 text-center">
                <span className="grid size-14 place-items-center rounded-full bg-secondary">
                  <SearchX aria-hidden className="size-6 text-foreground" strokeWidth={2} />
                </span>
                <span className="text-[20px] font-extrabold text-foreground">
                  Aucun produit ne correspond
                </span>
                <span className="max-w-[40ch] text-[15px] text-muted-foreground">
                  Essayez de retirer un filtre ou d&apos;élargir la fourchette de prix.
                </span>
                {activeChips.length > 0 && (
                  <button
                    type="button"
                    onClick={resetFilters}
                    className="mt-1 grid h-12 place-items-center rounded-full bg-foreground px-6 text-[14px] font-bold text-background transition-[filter] hover:brightness-110"
                  >
                    Réinitialiser les filtres
                  </button>
                )}
              </div>
            ))
          )}

          {/* Pagination */}
          {totalPages > 1 && (
            <Pagination
              page={page}
              totalPages={totalPages}
              rangeFrom={rangeFrom}
              rangeTo={rangeTo}
              total={count}
              onChange={goToPage}
            />
          )}
        </div>
      </div>

      {/* Mobile filter drawer */}
      {drawerOpen && (
        <Sheet
          titleId="listing-filters-title"
          title="Filtres"
          onClose={() => setDrawerOpen(false)}
          headerAction={
            activeChips.length > 0 && (
              <button
                type="button"
                onClick={resetFilters}
                className="h-9 rounded-full bg-primary/10 px-3 text-[13px] font-bold text-primary"
              >
                Réinitialiser
              </button>
            )
          }
          footer={
            <div className="shrink-0 border-t border-border px-4 py-3">
              <button
                type="button"
                onClick={() => setDrawerOpen(false)}
                className="grid h-[54px] w-full place-items-center rounded-full bg-primary text-[15px] font-bold text-primary-foreground"
              >
                Voir {count} produit{count > 1 ? "s" : ""}
              </button>
            </div>
          }
        >
          <div className="flex-1 overflow-y-auto overscroll-contain px-4">
            <FilterGroups listing={listing} />
          </div>
        </Sheet>
      )}
    </>
  );
}
