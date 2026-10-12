"use client";

import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { PackageSearch } from "lucide-react";

import { products as catalog, type Product } from "@/storefront/lib/catalog";
import { isOrderable } from "@/storefront/lib/productMeta";
import { EmptyState } from "@/storefront/components/storefront/empty-state";
import { CatalogProductCard } from "@/storefront/components/storefront/product-card";
import { SectionHeading, ViewAllLink } from "@/storefront/components/storefront/section-heading";
import { rhythm } from "@/storefront/components/storefront/ui-classes";
import { cn } from "@/storefront/lib/utils";

export type ProductTab = {
  label: string;
  resolve: () => Product[];
  /** The listing "Voir tout" opens while this tab is active. */
  href?: string;
};

/**
 * One full row of the widest grid (6 columns from 2xl). A tab other than the
 * first ("Tout") needs this many products to be shown, so no tab ends on a
 * half-empty row at 3 / 5 / 6 columns: fit() trims every tab to the same
 * number of whole rows.
 */
const FULL_ROW = 6;

/**
 * "iPhone 18 Pro Max 256Go SIM - Noir" -> "iphone 18 pro max"
 * "Coque en silicone MagSafe pour iPhone 17 Pro - Orange" -> "coque en silicone magsafe pour iphone 17 pro"
 *
 * Drops the storage tier and the trailing colour so a ten-card showcase shows
 * ten products rather than eight colourways of the same two.
 */
function variantKey(p: Product): string {
  return (
    p.title
      .split(/\s\d+\s*(?:Go|To|Gb|Tb)\b/i)[0]
      /* Strip a trailing " - <colour or edition>", but never a denomination:
         "Carte Cadeau iTunes USA - 100" and "- 50" are different products, not
         two colourways of one. */
      .replace(/\s*-\s*([^-]*)$/, (whole, tail: string) =>
        /[\d€$]|EUR|USD|TND/i.test(tail) ? whole : "",
      )
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase()
  );
}

/** One from each group in turn, so no single category fills the grid. */
function interleave(groups: Product[][]): Product[] {
  const out: Product[] = [];
  const longest = Math.max(0, ...groups.map((g) => g.length));
  for (let i = 0; i < longest; i++) {
    for (const g of groups) if (g[i]) out.push(g[i]);
  }
  return out;
}

/**
 * A tab over one or more catalogue categories; `null` means "every category".
 *
 * The export is grouped by category, so taking the first N in file order used
 * to hand the flagship "Tout" tab seven gaming mice. Products are therefore
 * grouped, de-duplicated by variant and interleaved before the caller slices.
 * Pre-orders count as sellable — filtering on in_stock alone would hide a whole
 * launch line-up — but a tab with nothing sellable still falls back to its full
 * pool rather than rendering empty.
 *
 * A single-category tab links "Voir tout" to that category's listing (every
 * category slug is a route); a multi-category tab falls back to the shelf's
 * own listing unless `href` names one.
 */
/**
 * Turn a product pool into a shelf: keep sellable first, group by category,
 * de-dupe variants, interleave so no single category fills the grid, and top up
 * from the skipped colourways if it's short of one full row.
 */
function buildShelf(pool: Product[]): Product[] {
  const sellable = pool.filter(isOrderable);
  const source = sellable.length ? sellable : pool;

  const groups = new Map<string, Product[]>();
  const seen = new Set<string>();
  /* Other colourways of a product already picked. */
  const repeats: Product[] = [];
  for (const p of source) {
    const key = variantKey(p);
    if (seen.has(key)) {
      repeats.push(p);
      continue;
    }
    seen.add(key);
    const group = groups.get(p.category);
    if (group) group.push(p);
    else groups.set(p.category, [p]);
  }
  const picked = interleave([...groups.values()]);
  /* A tab short of one full row takes back the colourways it skipped rather
     than disappearing. */
  return picked.length < FULL_ROW
    ? [...picked, ...repeats.slice(0, FULL_ROW - picked.length)]
    : picked;
}

export function categoryTab(label: string, categories: string[] | null, href?: string): ProductTab {
  return {
    label,
    href: href ?? (categories?.length === 1 ? `/${categories[0]}` : undefined),
    resolve: () =>
      buildShelf(
        categories === null ? catalog : catalog.filter((p) => categories.includes(p.category)),
      ),
  };
}

/**
 * A tab over a whole migration UNIVERSE (the top segment of each product's
 * `product_type` breadcrumb path, e.g. "Univers Apple" in
 * "Univers Apple / iPhones / iPhones Neufs"). Lets the home rail mirror the real
 * imported catalogue taxonomy instead of a hand-curated slug list.
 */
export function universeTab(label: string, universe: string, href?: string): ProductTab {
  const u = universe.trim();
  return {
    label,
    href,
    resolve: () =>
      buildShelf(catalog.filter((p) => (p.product_type ?? "").split(" / ")[0].trim() === u)),
  };
}

/**
 * Hides the cards past the shelf's row budget at each column count (3 from sm,
 * 5 from lg, 6 from 2xl). Every tab of a shelf gets the same number of whole
 * rows, set by its shortest tab (`shortest` cards), so switching tabs never
 * changes the grid's height (a 7-card tab beside a 12-card "Tout" moved the
 * page by a full 460px row at lg) and no tab ends on an orphan. A tab shorter
 * than one row keeps every card. Phones show the full rail. Tablets stop at
 * two rows: twelve cards in threes were four rows per shelf.
 */
function fit(i: number, n: number, shortest: number): string {
  const keep = (cols: number) => Math.min(n, cols * Math.max(1, Math.floor(shortest / cols)));
  return cn(
    i >= Math.min(6, keep(3)) && "sm:max-lg:hidden",
    i >= keep(5) && "lg:max-2xl:hidden",
    i >= keep(6) && "2xl:hidden",
  );
}

/** Fade whichever edge of the strip still has tabs beyond it. */
function edgeMask(start: boolean, end: boolean) {
  if (!start && !end) return undefined;
  const from = start ? "transparent, black 36px" : "black";
  const to = end ? "black calc(100% - 36px), transparent" : "black";
  const image = `linear-gradient(to right, ${from}, ${to})`;
  return { maskImage: image, WebkitMaskImage: image };
}

/**
 * The home page's tabbed product bloc: a section heading with a "Voir tout"
 * link to the active tab's listing, a pill tab strip in the same language as
 * the top nav bar, and the catalogue cards — a peeking rail on phones (the
 * page stays short and switching tabs never changes its height), a grid from
 * sm. The section chrome (padding, container) belongs to the caller.
 */
export function TabbedProducts({
  eyebrow,
  title,
  tabs,
  viewAllHref,
  limit = 12,
}: {
  eyebrow: ReactNode;
  title: string;
  tabs: ProductTab[];
  /** "Voir tout" target when the active tab has no listing of its own. */
  viewAllHref?: string;
  /**
   * Cards per tab: phones rail all of them; the grids show as many whole rows
   * (two at most) as the shelf's shortest tab fills.
   */
  limit?: number;
}) {
  const uid = useId();

  /* Every tab is resolved once, up front, so the sparse ones can be dropped
     before the strip renders: a tab short of one full row left three to five
     cards beside empty columns at lg / 2xl. */
  const shown = useMemo(
    () =>
      tabs
        .map((tab) => ({ tab, items: tab.resolve() }))
        .filter(({ items }, i) => i === 0 || items.length >= FULL_ROW),
    [tabs],
  );
  /* The shortest tab's card count sets the shelf's rows (see fit()). */
  const shortest = useMemo(
    () => Math.min(...shown.map(({ items }) => Math.min(items.length, limit))),
    [shown, limit],
  );
  const [active, setActive] = useState(0);
  const { tab: activeTab, items } = shown[active];
  const filtered = useMemo(() => items.slice(0, limit), [items, limit]);
  const n = filtered.length;
  const viewAll = activeTab.href ?? viewAllHref;
  /* A strip holding only "Tout" is noise: the grid follows the heading. */
  const tabbed = shown.length > 1;
  const panelProps = tabbed
    ? { id: `${uid}-panel`, role: "tabpanel", "aria-labelledby": `${uid}-tab-${active}` }
    : {};

  /* The strip overflows 2-3x on phones with the scrollbar suppressed: fade
     the edge(s) that still hide tabs — the only cue there is more to reach. */
  const stripRef = useRef<HTMLDivElement>(null);
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const [fade, setFade] = useState({ start: false, end: false });
  useEffect(() => {
    const el = stripRef.current;
    if (!el) return;
    const measure = () => {
      const max = el.scrollWidth - el.clientWidth;
      const start = el.scrollLeft > 4;
      const end = max > 1 && el.scrollLeft < max - 4;
      setFade((f) => (f.start === start && f.end === end ? f : { start, end }));
    };
    measure();
    el.addEventListener("scroll", measure, { passive: true });
    /* The tabs too, not just the strip: the web font swapping in widens them
       without resizing the strip. */
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    ro?.observe(el);
    for (const tab of el.children) ro?.observe(tab);
    return () => {
      el.removeEventListener("scroll", measure);
      ro?.disconnect();
    };
  }, [shown]);

  /* Tabs pattern: arrows move between tabs (and select them), Home/End jump. */
  const onStripKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const last = shown.length - 1;
    const next =
      e.key === "ArrowRight"
        ? active === last
          ? 0
          : active + 1
        : e.key === "ArrowLeft"
          ? active === 0
            ? last
            : active - 1
          : e.key === "Home"
            ? 0
            : e.key === "End"
              ? last
              : null;
    if (next === null) return;
    e.preventDefault();
    setActive(next);
    tabRefs.current[next]?.focus();
  };

  return (
    <div>
      <SectionHeading
        id={`${uid}-title`}
        eyebrow={eyebrow}
        title={title}
        action={viewAll ? <ViewAllLink href={viewAll} /> : undefined}
      />

      {/* Tab strip — a full-width capsule matching the grid beneath it and
          the top nav bar; tabs share the width evenly and scroll on phones.
          The frame and the scroller are split so the edge fade never erases
          the capsule's own border and cap, and the 5px inset lives on the
          scroller: it is the room the tabs' focus ring needs inside the clip.
          56px (1 + 5 + 44 + 5 + 1) = the pill's h-14 and the category
          toolbar, at every width. A block on the canvas, not a
          capsule floating over content: solid ground and the island shadow,
          like the category toolbar and the cards beneath it. */}
      {tabbed && (
        <div
          className={cn(
            rhythm.head,
            "rounded-full border border-border bg-background shadow-island",
          )}
        >
          <div
            ref={stripRef}
            role="tablist"
            aria-labelledby={`${uid}-title`}
            onKeyDown={onStripKeyDown}
            style={edgeMask(fade.start, fade.end)}
            className="no-scrollbar flex gap-1 overflow-x-auto rounded-full p-[5px]"
          >
            {shown.map(({ tab }, i) => {
              const selected = active === i;
              return (
                <button
                  key={tab.label}
                  ref={(el) => {
                    tabRefs.current[i] = el;
                  }}
                  type="button"
                  role="tab"
                  id={`${uid}-tab-${i}`}
                  aria-selected={selected}
                  aria-controls={`${uid}-panel`}
                  tabIndex={selected ? 0 : -1}
                  onClick={() => setActive(i)}
                  /* 44px (chip.lg) on every pointer, like the category
                     toolbar's controls and the heading's arrows and chip. */
                  className={cn(
                    "h-11 min-w-max flex-1 whitespace-nowrap rounded-full px-4 text-[13px] font-semibold transition-colors duration-200",
                    selected
                      ? "pill-gloss bg-primary text-primary-foreground"
                      : "text-graphite hover:bg-secondary hover:text-primary",
                  )}
                >
                  {tab.label}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {n > 0 ? (
        /* Phones: a rail bleeding to the screen edges, the gutter kept as snap
           padding, with ~a quarter of the next card peeking. py-3 is room for
           the cards' shadow and focus ring inside the scroll clip; -mb-3
           cancels it below. From sm: the grid, 3 / 5 / 6 columns. Keyed by
           tab so the rail starts at its first card on every switch.
           The gap above is the island gap (12 / 20 / 24) under the tab strip,
           as under the category toolbar — on phones the rail's own py-3 is
           those 12px — and the heading gap (20 / 24 / 32) when the grid
           follows the heading directly. */
        <div
          key={activeTab.label}
          {...panelProps}
          className={cn(
            "no-scrollbar mx-[calc(-1*var(--gutter))] -mb-3 flex snap-x snap-mandatory scroll-px-(--gutter) gap-3 overflow-x-auto px-(--gutter) py-3 sm:mx-0 sm:mb-0 sm:grid sm:grid-cols-3 sm:gap-5 sm:overflow-visible sm:px-0 sm:py-0 lg:grid-cols-5 lg:gap-6 2xl:grid-cols-6",
            tabbed ? "sm:mt-5 lg:mt-6" : "mt-2 sm:mt-6 lg:mt-8",
          )}
        >
          {filtered.map((p, i) => (
            <div
              key={p.slug}
              className={cn("w-[44%] shrink-0 snap-start sm:w-auto", fit(i, n, shortest))}
            >
              <CatalogProductCard product={p} />
            </div>
          ))}
        </div>
      ) : (
        <div {...panelProps}>
          <EmptyState
            icon={PackageSearch}
            title="Aucun produit pour le moment"
            className={cn(tabbed ? rhythm.island : rhythm.head, "max-w-none py-10 sm:py-12")}
          />
        </div>
      )}
    </div>
  );
}
