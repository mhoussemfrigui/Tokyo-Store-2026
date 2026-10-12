"use client";

import { useCallback, useMemo, useRef, useState } from "react";

import type { Product } from "@/storefront/lib/catalog";
import { smoothBehavior } from "@/storefront/lib/motion";

/**
 * The shared product-listing engine — the filter / sort / paginate logic behind
 * BOTH the category page and the search results page (the Normal V1 mockups share
 * the exact same listing surface). It is intentionally headless: this hook owns
 * state + the derived facets/results, and the presentational `<ListingRegion>`
 * (and each page's own header) read from it.
 *
 * All facets are derived CLIENT-SIDE from the `Product[]` the server hands over
 * (the storefront snapshot). Prices are DINARS here (not millimes) — the snapshot
 * DTO already carries major-unit `price`/`oldPrice`.
 */

export type ListingSort = "relevance" | "price-asc" | "price-desc" | "name-asc";

export const SORT_LABELS: Record<ListingSort, string> = {
  relevance: "Pertinence",
  "price-asc": "Prix croissant",
  "price-desc": "Prix décroissant",
  "name-asc": "Nom A–Z",
};

export type ListingCols = 3 | 4 | 5;

/** Fixed price bands (dinars). `max` is EXCLUSIVE for counting; a preset applies
 *  `pmin`/`pmax` (pmax inclusive) so the numeric inputs and the chips agree. */
const PRICE_BANDS: { label: string; min: number; max: number }[] = [
  { label: "Moins de 500 TND", min: 0, max: 500 },
  { label: "500 – 1 000 TND", min: 500, max: 1000 },
  { label: "1 000 – 2 500 TND", min: 1000, max: 2500 },
  { label: "2 500 – 5 000 TND", min: 2500, max: 5000 },
  { label: "Plus de 5 000 TND", min: 5000, max: Infinity },
];

export function conditionLabel(c: string): string {
  const k = (c || "").toLowerCase();
  if (k.includes("refurb") || k === "used") return "Reconditionné";
  if (k === "new") return "Neuf";
  return c || "Neuf";
}

export type Condition = "all" | "new" | "refurb";

export type PricePreset = {
  label: string;
  min: string;
  max: string;
  /** Count under the OTHER active facets. */
  count: number;
  /** Count across the whole set (decides whether the preset is worth showing). */
  total: number;
  active: boolean;
};

export type BrandFacet = { name: string; live: number; total: number };

export type ActiveChip = { key: string; label: string; onRemove: () => void };

export type ListingState = ReturnType<typeof useProductListing>;

export function useProductListing(products: Product[], perPage = 24) {
  const [selBrands, setSelBrands] = useState<Set<string>>(new Set());
  const [inStockOnly, setInStockOnly] = useState(false);
  const [condition, setConditionRaw] = useState<Condition>("all");
  const [pmin, setPminRaw] = useState("");
  const [pmax, setPmaxRaw] = useState("");
  const [sort, setSortRaw] = useState<ListingSort>("relevance");
  const [cols, setCols] = useState<ListingCols>(4);
  const [page, setPage] = useState(1);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [sortOpen, setSortOpen] = useState(false);

  const resultsRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLUListElement>(null);
  const capsuleRef = useRef<HTMLDivElement>(null);

  const priceCeil = useMemo(
    () => products.reduce((m, p) => Math.max(m, p.price), 0),
    [products],
  );

  /**
   * Does a product survive every active filter EXCEPT `skip`? Each facet is
   * counted with its own key skipped, so the numbers beside the options reflect
   * what you would actually get.
   */
  const passes = useCallback(
    (p: Product, skip?: "brand" | "stock" | "condition" | "price") => {
      if (skip !== "brand" && selBrands.size > 0) {
        const b = (p.brand || "Autres").trim() || "Autres";
        if (!selBrands.has(b)) return false;
      }
      if (skip !== "stock" && inStockOnly && p.availability !== "in_stock") return false;
      if (skip !== "condition" && condition !== "all") {
        const want = condition === "new" ? "Neuf" : "Reconditionné";
        if (conditionLabel(p.condition) !== want) return false;
      }
      if (skip !== "price") {
        if (pmin !== "" && p.price < +pmin) return false;
        if (pmax !== "" && p.price > +pmax) return false;
      }
      return true;
    },
    [selBrands, inStockOnly, condition, pmin, pmax],
  );

  const brands = useMemo<BrandFacet[]>(() => {
    const map = new Map<string, { live: number; total: number }>();
    products.forEach((p) => {
      const b = (p.brand || "Autres").trim() || "Autres";
      const entry = map.get(b) ?? { live: 0, total: 0 };
      entry.total += 1;
      if (passes(p, "brand")) entry.live += 1;
      map.set(b, entry);
    });
    return [...map.entries()]
      .map(([name, v]) => ({ name, live: v.live, total: v.total }))
      .sort((a, b) => b.total - a.total);
  }, [products, passes]);

  const conditionOptions = useMemo(
    () => [...new Set(products.map((p) => conditionLabel(p.condition)))],
    [products],
  );

  const inStockCount = useMemo(
    () => products.filter((p) => p.availability === "in_stock" && passes(p, "stock")).length,
    [products, passes],
  );

  const pricePresets = useMemo<PricePreset[]>(
    () =>
      PRICE_BANDS.map((b) => {
        const min = b.min === 0 ? "" : String(b.min);
        const max = b.max === Infinity ? "" : String(b.max - 1);
        const inBand = products.filter(
          (p) => (min === "" || p.price >= +min) && (max === "" || p.price <= +max),
        );
        return {
          label: b.label,
          min,
          max,
          total: inBand.length,
          count: inBand.filter((p) => passes(p, "price")).length,
          active: pmin === min && pmax === max && (min !== "" || max !== ""),
        };
      }).filter((b) => b.total > 0),
    [products, passes, pmin, pmax],
  );

  const filtered = useMemo(() => {
    const list = products.filter((p) => passes(p));
    switch (sort) {
      case "price-asc":
        return [...list].sort((a, b) => a.price - b.price);
      case "price-desc":
        return [...list].sort((a, b) => b.price - a.price);
      case "name-asc":
        return [...list].sort((a, b) => a.title.localeCompare(b.title, "fr"));
      default:
        return list; // relevance = as received (snapshot / search-score order)
    }
  }, [products, passes, sort]);

  const count = filtered.length;
  const totalPages = Math.max(1, Math.ceil(count / perPage));
  const safePage = Math.min(page, totalPages);
  const shown = useMemo(
    () => filtered.slice((safePage - 1) * perPage, safePage * perPage),
    [filtered, safePage, perPage],
  );
  const rangeFrom = count === 0 ? 0 : (safePage - 1) * perPage + 1;
  const rangeTo = Math.min(safePage * perPage, count);

  /* Every setter resets to page 1 — a narrower result set must not leave the
     user stranded on a now-empty high page. */
  const toggleBrand = useCallback((b: string) => {
    setSelBrands((prev) => {
      const next = new Set(prev);
      if (next.has(b)) next.delete(b);
      else next.add(b);
      return next;
    });
    setPage(1);
  }, []);
  const setInStock = useCallback((v: boolean) => {
    setInStockOnly(v);
    setPage(1);
  }, []);
  const setCondition = useCallback((c: Condition) => {
    setConditionRaw(c);
    setPage(1);
  }, []);
  const setPmin = useCallback((v: string) => {
    setPminRaw(v.replace(/[^\d]/g, ""));
    setPage(1);
  }, []);
  const setPmax = useCallback((v: string) => {
    setPmaxRaw(v.replace(/[^\d]/g, ""));
    setPage(1);
  }, []);
  const applyPreset = useCallback((preset: PricePreset) => {
    if (preset.active) {
      setPminRaw("");
      setPmaxRaw("");
    } else {
      setPminRaw(preset.min);
      setPmaxRaw(preset.max);
    }
    setPage(1);
  }, []);
  const setSort = useCallback((s: ListingSort) => {
    setSortRaw(s);
    setPage(1);
  }, []);
  const resetFilters = useCallback(() => {
    setSelBrands(new Set());
    setInStockOnly(false);
    setConditionRaw("all");
    setPminRaw("");
    setPmaxRaw("");
    setPage(1);
  }, []);

  /** Page change that lands on the start of the results (under the sticky bars)
   *  and moves focus to the grid for keyboard users. */
  const goToPage = useCallback((n: number) => {
    setPage(n);
    const results = resultsRef.current;
    if (!results) return;
    const anchor = capsuleRef.current ?? results;
    const stickyTop = parseFloat(getComputedStyle(anchor).top) || 80;
    window.scrollTo({
      top: results.getBoundingClientRect().top + window.scrollY - stickyTop,
      behavior: smoothBehavior(),
    });
    requestAnimationFrame(() => gridRef.current?.focus({ preventScroll: true }));
  }, []);

  const activeChips = useMemo<ActiveChip[]>(() => {
    const chips: ActiveChip[] = [];
    if (inStockOnly)
      chips.push({ key: "stock", label: "En stock", onRemove: () => setInStock(false) });
    if (condition !== "all")
      chips.push({
        key: "cond",
        label: condition === "new" ? "Neuf" : "Reconditionné",
        onRemove: () => setCondition("all"),
      });
    if (pmin !== "" || pmax !== "") {
      const label =
        pmin !== "" && pmax !== ""
          ? `${pmin} – ${pmax} TND`
          : pmin !== ""
            ? `≥ ${pmin} TND`
            : `≤ ${pmax} TND`;
      chips.push({
        key: "price",
        label,
        onRemove: () => {
          setPminRaw("");
          setPmaxRaw("");
          setPage(1);
        },
      });
    }
    selBrands.forEach((b) =>
      chips.push({ key: `brand-${b}`, label: b, onRemove: () => toggleBrand(b) }),
    );
    return chips;
  }, [inStockOnly, condition, pmin, pmax, selBrands, setInStock, setCondition, toggleBrand]);

  return {
    // facets
    brands,
    pricePresets,
    priceCeil,
    conditionOptions,
    inStockCount,
    // filter state
    selBrands,
    inStockOnly,
    condition,
    pmin,
    pmax,
    // view state
    sort,
    cols,
    page: safePage,
    drawerOpen,
    sortOpen,
    // results
    filtered,
    shown,
    count,
    totalPages,
    rangeFrom,
    rangeTo,
    activeChips,
    // refs
    resultsRef,
    gridRef,
    capsuleRef,
    // handlers
    toggleBrand,
    setInStock,
    setCondition,
    setPmin,
    setPmax,
    applyPreset,
    setSort,
    setCols,
    goToPage,
    resetFilters,
    setDrawerOpen,
    setSortOpen,
  };
}
