"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import {
  Bell,
  Check,
  ChevronRight,
  Coins,
  Heart,
  House,
  Percent,
  Phone,
  Search,
  ShoppingBag,
  SlidersHorizontal,
  Sparkles,
  Star,
  TrendingDown,
  TrendingUp,
  Trophy,
  X,
} from "lucide-react";

import { ServiceBand } from "@/storefront/components/storefront/listing/service-band";
import type { Product } from "@/storefront/lib/catalog";
import {
  collectionCopy,
  type CollectionSortKey,
} from "@/storefront/lib/collection-copy";
import type { CollectionSlug } from "@/lib/pages/collection-slugs";
import type { CollectionStrategy } from "@/lib/pages/collection-page-config";
import { addToCart } from "@/storefront/lib/cart";
import { toggleFavorite, useIsFavorite } from "@/storefront/lib/favorites";
import { universeCrumbs } from "@/storefront/lib/categoryNav";
import { smoothBehavior } from "@/storefront/lib/motion";
import {
  STOCK_LABEL,
  conditionLabel,
  fmtPrice,
  productRating,
  stockState,
} from "@/storefront/lib/productMeta";
import { cn } from "@/storefront/lib/utils";

/** Per-card backend stats attached by the server loader, keyed by product id. */
export type CollectionCardExtra = {
  /** best_sellers: units sold in each period window [p0, p1, p2]. */
  sales?: [number, number, number];
  /** new_arrivals: whole days since publication (null = never stamped). */
  days?: number | null;
  /** on_promotion: live effective price (dinars) — overrides the snapshot price. */
  price?: number;
  /** on_promotion: live compare-at (dinars) — the markdown shown on the card. */
  oldPrice?: number | null;
};

/**
 * The price a card actually shows. For the Promotions page this is the LIVE
 * price + compare-at (so an engine-only promo the snapshot hasn't captured still
 * reads its discount); everywhere else it's the snapshot card's own pricing
 * (consistent with the category pages + the rest of the store).
 */
function pricingOf(product: Product, extra?: CollectionCardExtra): {
  price: number;
  strike: number | null;
  off: number;
  save: number;
} {
  const price = extra?.price ?? product.price;
  const rawStrike = extra && "oldPrice" in extra ? extra.oldPrice ?? null : product.oldPrice ?? null;
  // A markdown counts only at ≥1% — a sub-rounding "−0 %" would otherwise show on
  // the card while the header stats (gated on off>0) exclude it. Keeping
  // strike/off/save in lockstep means the card and header never disagree.
  const off = rawStrike != null && rawStrike > price ? Math.round((1 - price / rawStrike) * 100) : 0;
  const strike = off >= 1 ? rawStrike : null;
  return { price, strike, off: strike ? off : 0, save: strike ? strike - price : 0 };
}

export type CollectionCtaBand = {
  eyebrow: string;
  title: string;
  subtitle: string;
  ctaLabel: string;
  ctaHref: string;
};

type Props = {
  slug: CollectionSlug;
  strategy: CollectionStrategy;
  /** H1 — the admin-editable page title. */
  title: string;
  /** Lead paragraph — admin subtitle, else the collection default copy. */
  catDesc: string;
  /** Snapshot cards in render order (pins first, then the strategy pool). */
  products: Product[];
  extrasById: Record<string, CollectionCardExtra>;
  empty: { title: string; body: string };
  showClosingCta: boolean;
  ctaBand: CollectionCtaBand;
  navBar: "hidden" | "categories" | "retour";
  /** Real backend contact phone for the FAQ "une autre question ?" CTA. */
  phone: string | null;
};

const MEDALS = ["bg-primary text-primary-foreground", "bg-foreground text-background", "bg-[#c9c2ba] text-foreground"];
const PRICE_PRESETS: { label: string; min: string; max: string }[] = [
  { label: "Moins de 300", min: "", max: "299" },
  { label: "300 – 1 000", min: "300", max: "1000" },
  { label: "Plus de 1 000", min: "1000", max: "" },
];
const SORT_ICON: Record<CollectionSortKey, typeof Trophy> = {
  best: Trophy,
  asc: TrendingUp,
  desc: TrendingDown,
  disc: Percent,
  save: Coins,
};

/** A product's coarse "Rayon" = the first segment of its taxonomy path. */
function rayonOf(p: Product): string {
  return (p.product_type || "").split("/")[0]?.trim() || "Autres";
}

/** Relative arrival label for Nouveautés (days since publication). */
function agoLabel(days: number | null): string {
  if (days == null) return "Récemment";
  if (days <= 0) return "Aujourd'hui";
  if (days === 1) return "Arrivé hier";
  if (days < 7) return `Il y a ${days} jours`;
  if (days < 14) return "Il y a 1 semaine";
  if (days < 30) return `Il y a ${Math.floor(days / 7)} semaines`;
  if (days < 60) return "Il y a 1 mois";
  return `Il y a ${Math.floor(days / 30)} mois`;
}

export function CollectionView(props: Props) {
  const { slug, strategy, title, catDesc, products, extrasById, empty, navBar, phone } = props;
  const copy = collectionCopy(slug);
  const hasPeriods = !!copy.periods && (strategy === "best_sellers" || strategy === "new_arrivals");
  const defaultSort = copy.sorts[0]?.key ?? "best";

  const [per, setPer] = useState(copy.defaultPeriod ?? 0);
  const [podAnim, setPodAnim] = useState(true);
  const [type, setType] = useState("all");
  const [brands, setBrands] = useState<string[]>([]);
  const [cond, setCond] = useState<string>("all");
  const [inStock, setInStock] = useState(false);
  const [disc, setDisc] = useState(0);
  const [pmin, setPmin] = useState("");
  const [pmax, setPmax] = useState("");
  const [sort, setSort] = useState<CollectionSortKey>(defaultSort);
  const [cols, setCols] = useState<3 | 4 | 5>(4);
  const [page, setPage] = useState(1);
  const [sortOpen, setSortOpen] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [narrow, setNarrow] = useState(false);
  const [faq, setFaq] = useState(0);
  const [descOpen, setDescOpen] = useState(false);
  const [closed, setClosed] = useState<Record<string, boolean>>({});

  const perPage = 12;
  const aboutRef = useRef<HTMLDivElement>(null);
  const listTopRef = useRef<HTMLDivElement>(null);
  const sortBoxRef = useRef<HTMLDivElement>(null);

  // Responsive: the sidebar becomes a slide-in drawer under 980px.
  useEffect(() => {
    const onResize = () => {
      const n = window.innerWidth < 980;
      setNarrow((prev) => (prev !== n ? n : prev));
      if (n) setDrawer(false);
    };
    window.addEventListener("resize", onResize);
    onResize();
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // Close the sort popover on outside-click / Escape.
  useEffect(() => {
    if (!sortOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (sortBoxRef.current && !sortBoxRef.current.contains(e.target as Node)) setSortOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => e.key === "Escape" && setSortOpen(false);
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onEsc);
    };
  }, [sortOpen]);

  const reset = (patch: Record<string, unknown>) => {
    // Any filter change returns to page 1 (the mockup's `set`).
    if ("type" in patch) setType(patch.type as string);
    if ("brands" in patch) setBrands(patch.brands as string[]);
    if ("cond" in patch) setCond(patch.cond as string);
    if ("inStock" in patch) setInStock(patch.inStock as boolean);
    if ("disc" in patch) setDisc(patch.disc as number);
    if ("pmin" in patch) setPmin(patch.pmin as string);
    if ("pmax" in patch) setPmax(patch.pmax as string);
    setPage(1);
  };
  const toggleBrand = (b: string) =>
    reset({ brands: brands.includes(b) ? brands.filter((x) => x !== b) : [...brands, b] });

  // Per-card derived facets (resolved price/strike/off/save, rayon, sold/days).
  const meta = useMemo(() => {
    const m = new Map<
      string,
      {
        off: number;
        save: number;
        price: number;
        strike: number | null;
        rayon: string;
        sold: number;
        days: number | null;
        cond: string;
      }
    >();
    for (const p of products) {
      const extra = p.id ? extrasById[p.id] : undefined;
      const pr = pricingOf(p, extra);
      m.set(p.slug, {
        off: pr.off,
        save: pr.save,
        price: pr.price,
        strike: pr.strike,
        rayon: rayonOf(p),
        sold: extra?.sales ? extra.sales[per] ?? 0 : 0,
        days: extra?.days ?? null,
        cond: conditionLabel(p.condition),
      });
    }
    return m;
  }, [products, extrasById, per]);

  const ceil = useMemo(() => Math.max(0, ...[...meta.values()].map((m) => m.price)), [meta]);

  const pass = (p: Product, except?: string) => {
    const mt = meta.get(p.slug)!;
    if (except !== "type" && type !== "all" && mt.rayon !== type) return false;
    if (except !== "brand" && brands.length && !brands.includes(p.brand || "")) return false;
    if (cond !== "all" && mt.cond !== cond) return false;
    if (inStock && stockState(p) !== "in_stock") return false;
    if (pmin !== "" && mt.price < Number(pmin)) return false;
    if (pmax !== "" && mt.price > Number(pmax)) return false;
    // A Promotions page lists only genuinely-discounted products — a backend
    // candidate whose live price has erased the markdown is dropped.
    if (strategy === "on_promotion" && mt.off <= 0) return false;
    if (except !== "disc" && strategy === "on_promotion" && mt.off < disc) return false;
    // Nouveautés: the period selector is an AGE window on the set itself.
    if (except !== "per" && strategy === "new_arrivals" && copy.windows) {
      const d = mt.days;
      if (d == null || d > copy.windows[per]!) return false;
    }
    return true;
  };

  // Top-ventes ranking: position among ALL products by the chosen period's sales.
  const rankOf = useMemo(() => {
    const r = new Map<string, number>();
    if (strategy === "best_sellers") {
      [...products]
        .sort((a, b) => (meta.get(b.slug)!.sold - meta.get(a.slug)!.sold))
        .forEach((p, i) => r.set(p.slug, i + 1));
    }
    return r;
  }, [products, meta, strategy]);

  const filtered = useMemo(() => {
    const list = products.filter((p) => pass(p));
    const sorters: Record<CollectionSortKey, (a: Product, b: Product) => number> = {
      best:
        strategy === "best_sellers"
          ? (a, b) => (rankOf.get(a.slug) ?? 1e9) - (rankOf.get(b.slug) ?? 1e9)
          : (a, b) => {
              // new_arrivals "Plus récents": lowest day-count first; undated last.
              const da = meta.get(a.slug)!.days ?? 1e9;
              const db = meta.get(b.slug)!.days ?? 1e9;
              return da - db;
            },
      disc: (a, b) =>
        (stockState(b) === "in_stock" ? 1 : 0) - (stockState(a) === "in_stock" ? 1 : 0) ||
        meta.get(b.slug)!.off - meta.get(a.slug)!.off,
      save: (a, b) => meta.get(b.slug)!.save - meta.get(a.slug)!.save,
      asc: (a, b) => meta.get(a.slug)!.price - meta.get(b.slug)!.price,
      desc: (a, b) => meta.get(b.slug)!.price - meta.get(a.slug)!.price,
    };
    return [...list].sort(sorters[sort] ?? sorters.best);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [products, meta, rankOf, sort, type, brands, cond, inStock, disc, pmin, pmax, per, strategy]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / perPage));
  const curPage = Math.min(page, pageCount);
  const visible = filtered.slice((curPage - 1) * perPage, curPage * perPage);
  const pageNums = useMemo(() => {
    const nums: (number | "…")[] = [];
    for (let i = 1; i <= pageCount; i++) {
      if (i === 1 || i === pageCount || Math.abs(i - curPage) <= 1) nums.push(i);
      else if (nums[nums.length - 1] !== "…") nums.push("…");
    }
    return nums;
  }, [pageCount, curPage]);

  // Facets (counts honour every OTHER active filter — the "except" trick).
  const rayons = useMemo(() => {
    const groups = new Map<string, { count: number; img: string }>();
    for (const p of products) {
      if (!pass(p, "type")) continue;
      const key = meta.get(p.slug)!.rayon;
      const g = groups.get(key);
      if (g) g.count += 1;
      else groups.set(key, { count: 1, img: p.image });
    }
    return [...groups.entries()].map(([key, v]) => ({ key, ...v })).sort((a, b) => b.count - a.count);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [products, meta, brands, cond, inStock, disc, pmin, pmax, per, type]);

  const brandFacets = useMemo(() => {
    const names = [...new Set(products.map((p) => p.brand).filter(Boolean))] as string[];
    return names
      .map((name) => ({ name, count: products.filter((p) => pass(p, "brand") && p.brand === name).length }))
      .sort((a, b) => a.name.localeCompare(b.name));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [products, meta, type, cond, inStock, disc, pmin, pmax, per]);

  const condOptions = useMemo(() => {
    const present = [...new Set(products.map((p) => conditionLabel(p.condition)))];
    const order = ["Neuf", "Reconditionné"];
    return present.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  }, [products]);

  const discFacets = useMemo(() => {
    if (strategy !== "on_promotion" || !copy.discountBuckets) return [];
    return copy.discountBuckets.map((b) => ({
      ...b,
      count: products.filter((p) => pass(p, "disc") && meta.get(p.slug)!.off >= b.min).length,
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [products, meta, strategy, type, brands, cond, inStock, pmin, pmax]);

  // Header stats (Promo) + weekly-arrivals count (Nouveautés), from real values.
  const offersWithStrike = useMemo(
    () => products.filter((p) => (meta.get(p.slug)?.off ?? 0) > 0),
    [products, meta],
  );
  const maxOff = useMemo(
    () => Math.max(0, ...offersWithStrike.map((p) => meta.get(p.slug)!.off)),
    [offersWithStrike, meta],
  );
  const avgSave = useMemo(() => {
    if (offersWithStrike.length === 0) return 0;
    const total = offersWithStrike.reduce((a, p) => a + (meta.get(p.slug)?.save ?? 0), 0);
    return Math.round(total / offersWithStrike.length);
  }, [offersWithStrike, meta]);
  const weekCount = useMemo(
    () => products.filter((p) => { const d = meta.get(p.slug)!.days; return d != null && d <= 7; }).length,
    [products, meta],
  );
  const totalSales = useMemo(
    () => products.reduce((a, p) => a + (meta.get(p.slug)?.sold ?? 0), 0),
    [products, meta],
  );

  // Podium / "tout juste arrivés" — top 3 by the active measure.
  const podium = useMemo(() => {
    if (strategy === "best_sellers") {
      // Only products with real sales in the active period — so the podium never
      // crowns a "0 vendus" product (cold-start / a quiet window shows no podium).
      return [...products]
        .filter((p) => meta.get(p.slug)!.sold > 0)
        .sort((a, b) => meta.get(b.slug)!.sold - meta.get(a.slug)!.sold)
        .slice(0, 3);
    }
    if (strategy === "new_arrivals") {
      // Most recently ARRIVED (in-stock/oos) products — a preorder hasn't arrived
      // yet, so it's excluded from "Tout juste arrivés".
      return [...products]
        .filter((p) => meta.get(p.slug)!.days != null && stockState(p) !== "backorder")
        .sort((a, b) => (meta.get(a.slug)!.days ?? 1e9) - (meta.get(b.slug)!.days ?? 1e9))
        .slice(0, 3);
    }
    return [];
  }, [products, meta, strategy]);

  const activeChips = useMemo(() => {
    const chips: { label: string; clear: () => void }[] = [];
    if (type !== "all") chips.push({ label: type, clear: () => reset({ type: "all" }) });
    brands.forEach((b) => chips.push({ label: b, clear: () => toggleBrand(b) }));
    if (cond !== "all") chips.push({ label: cond, clear: () => reset({ cond: "all" }) });
    if (strategy === "on_promotion" && disc > 0)
      chips.push({ label: `−${disc} % et plus`, clear: () => reset({ disc: 0 }) });
    if (inStock) chips.push({ label: "En stock", clear: () => reset({ inStock: false }) });
    if (pmin !== "" || pmax !== "")
      chips.push({
        label: `${pmin || 0} – ${pmax || ceil} TND`,
        clear: () => reset({ pmin: "", pmax: "" }),
      });
    return chips;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type, brands, cond, disc, inStock, pmin, pmax, ceil, strategy]);

  const resetAll = () =>
    reset({ type: "all", brands: [], cond: "all", inStock: false, disc: 0, pmin: "", pmax: "" });

  const goPage = (n: number) => {
    setPage(n);
    const el = listTopRef.current;
    if (el && el.getBoundingClientRect().top < 0)
      window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - 20, behavior: smoothBehavior() });
  };
  const scrollToAbout = () => {
    const el = aboutRef.current;
    if (el)
      window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - 20, behavior: smoothBehavior() });
  };
  const pickPeriod = (i: number) => {
    if (i === per) return;
    setPodAnim(false);
    setTimeout(() => {
      setPer(i);
      setPodAnim(true);
      setPage(1);
    }, 180);
  };

  const grp = (k: string) => ({
    open: !closed[k],
    toggle: () => setClosed((c) => ({ ...c, [k]: !c[k] })),
  });

  const telHref = phone ? `tel:${phone.replace(/[^+\d]/g, "")}` : null;
  const perWord = copy.periods?.[per]?.word ?? "";

  return (
    <div className="page-container flex flex-col gap-5 pt-3">
      {/* ── 1. Header ─────────────────────────────────────────────── */}
      <section className="flex flex-col gap-7 rounded-[36px] bg-background p-6 sm:p-9 lg:p-12">
        <nav aria-label="Fil d'Ariane" className="flex min-w-0 items-center gap-1.5 overflow-hidden">
          <Link
            href="/"
            aria-label="Accueil"
            className="grid size-[30px] shrink-0 place-items-center rounded-full bg-secondary text-foreground transition-colors hover:bg-primary/10 hover:text-primary"
          >
            <House aria-hidden className="size-3.5" strokeWidth={2} />
          </Link>
          <ChevronRight aria-hidden className="size-3 shrink-0 text-muted-foreground/50" strokeWidth={2.4} />
          <span
            aria-current="page"
            className="shrink-0 rounded-full bg-primary/10 px-3 py-1.5 text-[13px] font-semibold text-primary"
          >
            {title}
          </span>
        </nav>

        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-3.5">
            <h1 className="text-[clamp(44px,6.5vw,96px)] font-black leading-[0.92] tracking-[-0.05em] text-foreground">
              {title}
            </h1>
            {strategy === "on_promotion"
              ? maxOff > 0 && (
                  <span className="flex h-11 -rotate-3 items-center rounded-full bg-primary px-4 text-[16px] font-black text-primary-foreground">
                    Jusqu&apos;à −{maxOff}&nbsp;%
                  </span>
                )
              : (
                  <span className="flex h-10 items-center gap-2 rounded-full bg-success/10 px-3.5 text-[14px] font-extrabold text-success">
                    <span className="size-2 rounded-full bg-success ring-4 ring-success/20" />
                    {strategy === "new_arrivals"
                      ? `${weekCount} arrivage${weekCount === 1 ? "" : "s"} cette semaine`
                      : "Mis à jour aujourd'hui"}
                  </span>
                )}
          </div>

          <p className="max-w-[60ch] text-[16px] leading-relaxed text-graphite text-pretty">
            {catDesc}{" "}
            <button
              type="button"
              onClick={scrollToAbout}
              className="font-bold text-foreground underline underline-offset-[3px]"
            >
              {copy.aboutLinkLabel}
            </button>
          </p>

          {strategy === "on_promotion" && offersWithStrike.length > 0 && (
            <div className="flex flex-wrap gap-2">
              <span className="flex h-9 items-center gap-1.5 rounded-full bg-secondary px-3.5 text-[13px] font-bold text-foreground">
                <strong className="text-[15px]">{offersWithStrike.length}</strong> offre
                {offersWithStrike.length === 1 ? "" : "s"} en cours
              </span>
              {avgSave > 0 && (
                <span className="flex h-9 items-center gap-1.5 rounded-full bg-secondary px-3.5 text-[13px] font-bold text-foreground">
                  Économie moyenne <strong className="text-[15px] text-primary">{fmtPrice(avgSave)} TND</strong>
                </span>
              )}
            </div>
          )}

          {hasPeriods && copy.periods && (
            <div
              role="radiogroup"
              aria-label="Période"
              className="relative grid w-full max-w-[460px] grid-cols-3 rounded-full bg-secondary p-1"
            >
              <span
                aria-hidden
                className="absolute inset-y-1 rounded-full bg-foreground transition-[left] duration-300 ease-out"
                style={{ left: `calc(4px + ${per} * (100% - 8px) / 3)`, width: "calc((100% - 8px) / 3)" }}
              />
              {copy.periods.map((p, i) => (
                <button
                  key={p.label}
                  type="button"
                  role="radio"
                  aria-checked={per === i}
                  onClick={() => pickPeriod(i)}
                  className={cn(
                    "relative h-11 whitespace-nowrap rounded-full text-[14px] font-bold transition-colors",
                    per === i ? "text-background" : "text-foreground",
                  )}
                >
                  {p.label}
                </button>
              ))}
            </div>
          )}
        </div>

        {navBar === "categories" && (
          <div className="flex flex-wrap gap-2 border-t border-border/70 pt-5">
            {universeCrumbs.map((c) => (
              <Link
                key={c.slug}
                href={`/${c.slug}`}
                className="flex h-10 items-center rounded-full bg-secondary px-4 text-[13px] font-bold text-foreground transition-colors hover:bg-foreground hover:text-background"
              >
                {c.label}
              </Link>
            ))}
          </div>
        )}

        {rayons.length > 1 && (
          <RayonsRail
            rayons={rayons}
            active={type}
            title={strategy === "on_promotion" ? "Rayons en promo" : "Rayons"}
            allLabel={strategy === "on_promotion" ? "Toutes les offres" : "Tous les rayons"}
            onPick={(k) => reset({ type: k })}
          />
        )}
      </section>

      {/* ── 2. Podium / Tout juste arrivés ───────────────────────────── */}
      {podium.length > 0 && (
        <section className="flex flex-col gap-4 px-1 pt-2">
          <div className="flex flex-wrap items-end justify-between gap-2.5">
            <h2 className="text-[clamp(28px,3vw,44px)] font-extrabold tracking-[-0.03em] text-foreground">
              {strategy === "best_sellers" ? `${copy.podiumTitle} ${perWord}`.trim() : copy.podiumTitle}
            </h2>
            <span className="text-[14px] text-muted-foreground">
              {strategy === "best_sellers" && totalSales > 0
                ? `Basé sur ${fmtPrice(totalSales)} ventes en ligne et en boutique`
                : copy.podiumNote}
            </span>
          </div>
          <div
            className={cn(
              "grid gap-3 transition-opacity duration-200 [grid-template-columns:repeat(auto-fit,minmax(min(100%,300px),1fr))]",
              podAnim ? "opacity-100" : "opacity-0",
            )}
          >
            {podium.map((p, i) => {
              const mt = meta.get(p.slug)!;
              return (
                <Link
                  key={p.slug}
                  href={`/${p.slug}`}
                  className={cn(
                    "flex min-w-0 items-center gap-3.5 rounded-[26px] border-[1.5px] bg-background p-2.5 pr-3.5 transition-[transform,box-shadow] duration-300 hover:-translate-y-0.5 hover:shadow-island",
                    i === 0 ? "border-primary" : "border-border",
                  )}
                >
                  <span className="relative aspect-square w-[clamp(84px,8vw,104px)] shrink-0 rounded-[18px] bg-secondary bg-contain bg-center bg-no-repeat"
                    style={{ backgroundImage: `url(${p.image})`, backgroundSize: "82%" }}
                  >
                    <span
                      className={cn(
                        "absolute -left-1.5 -top-1.5 grid size-[34px] place-items-center rounded-full border-[3px] border-background text-[15px] font-black",
                        // Nouveautés medals are all crimson (the number is an age,
                        // not a rank); Top ventes uses gold/black/grey per rank.
                        strategy === "new_arrivals"
                          ? "bg-primary text-primary-foreground"
                          : MEDALS[i] ?? MEDALS[2],
                      )}
                    >
                      {strategy === "new_arrivals" && mt.days != null
                        ? mt.days === 0
                          ? "Auj."
                          : `${mt.days}j`
                        : i + 1}
                    </span>
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col gap-1">
                    <span className="eyebrow truncate text-muted-foreground">{p.brand || "Tokyo Store"}</span>
                    <span className="line-clamp-2 text-[15px] font-extrabold leading-tight text-foreground">
                      {p.title}
                    </span>
                    <span className="mt-0.5 flex flex-wrap items-center gap-x-2.5 gap-y-1">
                      <span className="whitespace-nowrap text-[17px] font-black text-primary">
                        {fmtPrice(p.price)} <span className="text-[11px]">TND</span>
                      </span>
                      <span className="whitespace-nowrap text-[12px] font-bold text-muted-foreground">
                        {strategy === "best_sellers" ? `${fmtPrice(mt.sold)} vendus` : agoLabel(mt.days)}
                      </span>
                    </span>
                  </span>
                </Link>
              );
            })}
          </div>
        </section>
      )}

      {/* ── 3. Listing ────────────────────────────────────────────── */}
      <section ref={listTopRef} className="flex scroll-mt-5 items-start gap-5">
        {narrow && drawer && (
          <button
            type="button"
            aria-label="Fermer les filtres"
            onClick={() => setDrawer(false)}
            className="fixed inset-0 z-[55] bg-foreground/40 backdrop-blur-[2px]"
          />
        )}

        {/* Filter sidebar / drawer */}
        <aside
          aria-label="Filtres"
          className={cn(
            "flex flex-col rounded-[28px] bg-background px-6 scrollbar-thin",
            narrow
              ? "fixed inset-y-3 left-3 z-[60] w-[min(380px,calc(100%-24px))] overflow-y-auto shadow-float transition-transform duration-300 ease-out"
              : "relative w-[320px] shrink-0",
            narrow && !drawer && "-translate-x-[calc(100%+24px)]",
          )}
        >
          <div className="flex h-[72px] shrink-0 items-center justify-between gap-3">
            <span className="text-[20px] font-extrabold tracking-[-0.02em]">Filtres</span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={resetAll}
                className={cn(
                  "h-8 rounded-full px-3 text-[13px] font-bold transition-colors",
                  activeChips.length ? "bg-primary/10 text-primary" : "bg-secondary text-muted-foreground",
                )}
              >
                Réinitialiser
              </button>
              {narrow && (
                <button
                  type="button"
                  aria-label="Fermer"
                  onClick={() => setDrawer(false)}
                  className="grid size-10 place-items-center rounded-full border border-border bg-background text-foreground"
                >
                  <X aria-hidden className="size-4" />
                </button>
              )}
            </div>
          </div>

          <FilterGroup label="Prix" state={grp("prix")}>
            <div className="grid grid-cols-2 gap-2">
              <PriceField label="Min" value={pmin} placeholder="0" onChange={(v) => reset({ pmin: v })} />
              <PriceField label="Max" value={pmax} placeholder={String(ceil)} onChange={(v) => reset({ pmax: v })} />
            </div>
            <div className="mt-2.5 flex flex-wrap gap-1.5">
              {PRICE_PRESETS.map((pr) => {
                const on = pmin === pr.min && pmax === pr.max && (pr.min !== "" || pr.max !== "");
                return (
                  <button
                    key={pr.label}
                    type="button"
                    onClick={() => reset(on ? { pmin: "", pmax: "" } : { pmin: pr.min, pmax: pr.max })}
                    className={cn(
                      "h-[34px] rounded-full border px-3 text-[13px] font-semibold transition-colors",
                      on ? "border-foreground bg-foreground text-background" : "border-border bg-background text-foreground",
                    )}
                  >
                    {pr.label}
                  </button>
                );
              })}
            </div>
          </FilterGroup>

          {brandFacets.length > 1 && (
            <FilterGroup label="Marque" state={grp("marque")}>
              <div className="flex flex-col gap-0.5">
                {brandFacets.map((b) => {
                  const on = brands.includes(b.name);
                  const dim = !on && b.count === 0;
                  return (
                    <button
                      key={b.name}
                      type="button"
                      disabled={dim}
                      onClick={() => toggleBrand(b.name)}
                      className={cn(
                        "flex h-11 items-center gap-3 rounded-xl px-1 text-left text-[14px] font-semibold text-foreground transition-colors hover:bg-secondary/60",
                        dim && "opacity-40",
                      )}
                    >
                      <span
                        className={cn(
                          "grid size-[22px] shrink-0 place-items-center rounded-[7px] border-[1.5px] transition-colors",
                          on ? "border-primary bg-primary text-primary-foreground" : "border-muted-foreground/50 bg-background",
                        )}
                      >
                        {on && <Check aria-hidden className="size-3" strokeWidth={3.2} />}
                      </span>
                      <span className="flex-1">{b.name}</span>
                      <span className="text-[12px] font-semibold tabular-nums text-muted-foreground">{b.count}</span>
                    </button>
                  );
                })}
              </div>
            </FilterGroup>
          )}

          {strategy === "on_promotion" && discFacets.length > 0 && (
            <FilterGroup label="Remise" state={grp("remise")}>
              <div role="radiogroup" aria-label="Remise minimum" className="flex flex-col gap-0.5">
                {discFacets.map((d) => {
                  const on = disc === d.min;
                  const dim = !on && d.count === 0;
                  return (
                    <button
                      key={d.min}
                      type="button"
                      role="radio"
                      aria-checked={on}
                      disabled={dim}
                      onClick={() => reset({ disc: d.min })}
                      className={cn(
                        "flex h-11 items-center gap-3 rounded-xl px-1 text-left text-[14px] font-semibold text-foreground transition-colors hover:bg-secondary/60",
                        dim && "opacity-40",
                      )}
                    >
                      <span
                        className={cn(
                          "grid size-[22px] shrink-0 place-items-center rounded-full border-[1.5px] transition-colors",
                          on ? "border-primary" : "border-muted-foreground/50",
                        )}
                      >
                        <span className={cn("size-3 rounded-full bg-primary transition-transform", on ? "scale-100" : "scale-0")} />
                      </span>
                      <span className="flex-1">{d.label}</span>
                      <span className="text-[12px] font-semibold tabular-nums text-muted-foreground">{d.count}</span>
                    </button>
                  );
                })}
              </div>
            </FilterGroup>
          )}

          {condOptions.length > 1 && (
            <FilterGroup label="État" state={grp("etat")}>
              <div className="grid grid-cols-3 gap-1 rounded-full bg-secondary p-1">
                {["all", ...condOptions].map((k) => {
                  const on = cond === k;
                  return (
                    <button
                      key={k}
                      type="button"
                      onClick={() => reset({ cond: k })}
                      className={cn(
                        "h-[38px] rounded-full text-[13px] font-bold text-foreground transition-colors",
                        on ? "bg-background shadow-sm" : "",
                      )}
                    >
                      {k === "all" ? "Tous" : k}
                    </button>
                  );
                })}
              </div>
            </FilterGroup>
          )}

          <FilterGroup label="Disponibilité" state={grp("dispo")}>
            <button
              type="button"
              role="switch"
              aria-checked={inStock}
              onClick={() => reset({ inStock: !inStock })}
              className="flex h-12 w-full items-center justify-between gap-3 text-left text-[14px] font-semibold text-foreground"
            >
              <span>En stock uniquement</span>
              <span className={cn("flex h-7 w-[46px] shrink-0 items-center rounded-full p-[3px] transition-colors", inStock ? "bg-success" : "bg-muted-foreground/30")}>
                <span className={cn("size-[22px] rounded-full bg-background shadow transition-transform", inStock && "translate-x-[18px]")} />
              </span>
            </button>
          </FilterGroup>

          {narrow && (
            <div className="sticky bottom-0 mt-auto border-t border-border bg-background py-4">
              <button
                type="button"
                onClick={() => setDrawer(false)}
                className="h-[54px] w-full rounded-full bg-primary text-[15px] font-bold text-primary-foreground"
              >
                Voir {filtered.length} produit{filtered.length === 1 ? "" : "s"}
              </button>
            </div>
          )}
          <div className="h-3 shrink-0" />
        </aside>

        {/* Results column */}
        <div className="flex min-w-0 flex-1 flex-col gap-3.5">
          {/* Toolbar */}
          <div className="flex min-h-[64px] flex-wrap items-center justify-between gap-2.5 rounded-[24px] bg-background p-2 pl-4">
            <div className="flex items-center gap-3">
              {narrow && (
                <button
                  type="button"
                  onClick={() => setDrawer(true)}
                  className="flex h-11 items-center gap-2 rounded-full bg-foreground pl-3.5 pr-4 text-[14px] font-bold text-background"
                >
                  <SlidersHorizontal aria-hidden className="size-4" strokeWidth={2.2} />
                  Filtres
                  {activeChips.length > 0 && (
                    <span className="grid h-5 min-w-5 place-items-center rounded-full bg-primary px-1.5 text-[11px] text-primary-foreground">
                      {activeChips.length}
                    </span>
                  )}
                </button>
              )}
              <span className="text-[15px]">
                <strong>{filtered.length}</strong>{" "}
                <span className="text-muted-foreground">produit{filtered.length === 1 ? "" : "s"}</span>
              </span>
            </div>
            <div className="flex items-center gap-2">
              <div ref={sortBoxRef} className="relative">
                <button
                  type="button"
                  aria-haspopup="listbox"
                  aria-expanded={sortOpen}
                  onClick={() => setSortOpen((v) => !v)}
                  className={cn(
                    "flex h-11 items-center gap-2.5 rounded-full border-[1.5px] pl-4 pr-3.5 text-[14px] transition-colors",
                    sortOpen ? "border-foreground bg-background" : "border-border bg-secondary",
                  )}
                >
                  <span className="whitespace-nowrap text-muted-foreground">Trier par</span>
                  <strong className="whitespace-nowrap">{copy.sorts.find((o) => o.key === sort)?.label}</strong>
                  <ChevronRight aria-hidden className={cn("size-3.5 rotate-90 transition-transform", sortOpen && "-rotate-90")} strokeWidth={2.4} />
                </button>
                {sortOpen && (
                  <div
                    role="listbox"
                    className="absolute right-0 top-[calc(100%+8px)] z-30 w-[248px] rounded-[22px] border border-border bg-background p-1.5 shadow-float"
                  >
                    {copy.sorts.map((o) => {
                      const on = sort === o.key;
                      const Icon = o.key === "best" && strategy === "new_arrivals" ? Sparkles : SORT_ICON[o.key];
                      return (
                        <button
                          key={o.key}
                          type="button"
                          role="option"
                          aria-selected={on}
                          onClick={() => {
                            setSort(o.key);
                            setSortOpen(false);
                            setPage(1);
                          }}
                          className={cn(
                            "flex h-[46px] w-full items-center justify-between gap-3 rounded-2xl px-3.5 text-left text-[14px] transition-colors hover:bg-secondary",
                            on ? "bg-secondary/60 font-bold" : "font-medium",
                          )}
                        >
                          <span className="flex items-center gap-2.5">
                            <Icon aria-hidden className={cn("size-4", on ? "text-primary" : "text-muted-foreground")} strokeWidth={2.2} />
                            {o.label}
                          </span>
                          {on && (
                            <span className="grid size-[22px] place-items-center rounded-full bg-primary">
                              <Check aria-hidden className="size-3 text-primary-foreground" strokeWidth={3.4} />
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
              {!narrow && (
                <div role="radiogroup" aria-label="Produits par ligne" className="relative grid grid-cols-3 rounded-full bg-secondary p-[3px]">
                  <span
                    aria-hidden
                    className="absolute left-[3px] top-[3px] h-[38px] w-11 rounded-full bg-background shadow-sm transition-transform duration-300"
                    style={{ transform: `translateX(${(cols - 3) * 44}px)` }}
                  />
                  {([3, 4, 5] as const).map((c) => (
                    <button
                      key={c}
                      type="button"
                      role="radio"
                      aria-checked={cols === c}
                      aria-label={`${c} produits par ligne`}
                      onClick={() => setCols(c)}
                      className={cn("relative grid h-[38px] w-11 place-items-center transition-colors", cols === c ? "text-foreground" : "text-muted-foreground")}
                    >
                      <span className="flex items-stretch gap-[2px]" aria-hidden>
                        {Array.from({ length: c }).map((_, i) => (
                          <span key={i} className="h-4 w-[3px] rounded-sm bg-current" />
                        ))}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Active chips */}
          {activeChips.length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              {activeChips.map((c, i) => (
                <button
                  key={`${c.label}-${i}`}
                  type="button"
                  onClick={c.clear}
                  className="flex h-9 items-center gap-2 rounded-full bg-foreground pl-3.5 pr-2.5 text-[13px] font-semibold text-background"
                >
                  {c.label}
                  <span className="grid size-[18px] place-items-center rounded-full bg-background/20 text-[10px]">
                    <X aria-hidden className="size-2.5" strokeWidth={3} />
                  </span>
                </button>
              ))}
              <button
                type="button"
                onClick={resetAll}
                className="h-9 px-2.5 text-[13px] font-bold text-primary underline underline-offset-[3px]"
              >
                Tout effacer
              </button>
            </div>
          )}

          {/* Grid */}
          {visible.length > 0 ? (
            <div className="grid gap-3.5" style={{ gridTemplateColumns: narrow ? "repeat(auto-fill,minmax(min(100%,170px),1fr))" : `repeat(${cols},minmax(0,1fr))` }}>
              {visible.map((p) => (
                <CollectionCard
                  key={p.slug}
                  product={p}
                  extra={p.id ? extrasById[p.id] : undefined}
                  strategy={strategy}
                  rank={rankOf.get(p.slug)}
                  sold={meta.get(p.slug)!.sold}
                  days={meta.get(p.slug)!.days}
                />
              ))}
            </div>
          ) : (
            <div className="flex flex-col items-center gap-3.5 rounded-[28px] bg-background px-6 py-14 text-center">
              <span className="grid size-14 place-items-center rounded-full bg-secondary">
                <Search aria-hidden className="size-5 text-foreground" strokeWidth={2} />
              </span>
              <span className="text-[20px] font-extrabold">{activeChips.length ? "Aucun produit ne correspond" : empty.title}</span>
              <span className="max-w-[40ch] text-[15px] text-muted-foreground">
                {activeChips.length ? "Essayez de retirer un filtre ou d'élargir la fourchette de prix." : empty.body}
              </span>
              {activeChips.length > 0 && (
                <button
                  type="button"
                  onClick={resetAll}
                  className="h-12 rounded-full bg-foreground px-5.5 text-[14px] font-bold text-background"
                >
                  Réinitialiser les filtres
                </button>
              )}
            </div>
          )}

          {/* Pager */}
          {filtered.length > 0 && pageCount > 1 && (
            <nav
              aria-label="Pagination"
              className="mt-1.5 flex min-h-[64px] flex-wrap items-center justify-between gap-3 rounded-[24px] bg-background p-2 pl-5"
            >
              <span className="text-[14px] text-muted-foreground">
                Produits{" "}
                <strong className="text-foreground">
                  {(curPage - 1) * perPage + 1}–{Math.min(curPage * perPage, filtered.length)}
                </strong>{" "}
                sur {filtered.length}
              </span>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => curPage > 1 && goPage(curPage - 1)}
                  disabled={curPage <= 1}
                  aria-label="Page précédente"
                  className="grid size-11 place-items-center rounded-full border border-border bg-background text-[18px] text-foreground transition-colors hover:bg-secondary disabled:opacity-35"
                >
                  ‹
                </button>
                {pageNums.map((n, i) =>
                  n === "…" ? (
                    <span key={`gap-${i}`} className="grid size-11 place-items-center text-muted-foreground">
                      …
                    </span>
                  ) : (
                    <button
                      key={n}
                      type="button"
                      onClick={() => goPage(n)}
                      aria-current={n === curPage ? "page" : undefined}
                      className={cn(
                        "grid size-11 min-w-11 place-items-center rounded-full px-1.5 text-[14px] font-bold tabular-nums transition-colors",
                        n === curPage ? "bg-foreground text-background" : "bg-secondary text-foreground hover:brightness-95",
                      )}
                    >
                      {n}
                    </button>
                  ),
                )}
                <button
                  type="button"
                  onClick={() => curPage < pageCount && goPage(curPage + 1)}
                  disabled={curPage >= pageCount}
                  aria-label="Page suivante"
                  className="grid size-11 place-items-center rounded-full bg-foreground text-[18px] text-background transition-[filter] hover:brightness-125 disabled:opacity-35"
                >
                  ›
                </button>
              </div>
            </nav>
          )}
        </div>
      </section>

      {/* ── 4. Service band ─────────────────────────────────────────── */}
      <ServiceBand />

      {/* ── 5. About ───────────────────────────────────────────────── */}
      <section
        ref={aboutRef}
        className="flex scroll-mt-5 flex-col gap-7 rounded-[36px] bg-background p-7 sm:p-10 lg:p-16"
      >
        <h2 className="text-[clamp(28px,3vw,44px)] font-extrabold tracking-[-0.03em] text-foreground">
          {copy.aboutTitle}
        </h2>
        <div className="relative max-w-[820px]">
          <div className={cn("overflow-hidden transition-[max-height] duration-500", descOpen ? "max-h-[4000px]" : "max-h-[200px]")}>
            {copy.aboutParas.map((para, i) => (
              <p key={i} className="mb-[18px] text-[17px] leading-[1.75] text-[#2a2d33] text-pretty">
                {para}
              </p>
            ))}
          </div>
          {!descOpen && (
            <div aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-[90px] bg-gradient-to-t from-background to-transparent" />
          )}
        </div>
        <button
          type="button"
          onClick={() => setDescOpen((v) => !v)}
          className="flex h-[46px] w-fit items-center gap-2 rounded-full border-[1.5px] border-foreground bg-background px-5 text-[14px] font-bold text-foreground transition-colors hover:bg-foreground hover:text-background"
        >
          {descOpen ? "Réduire" : "Lire la suite"}
          <ChevronRight aria-hidden className={cn("size-3.5 rotate-90 transition-transform", descOpen && "-rotate-90")} strokeWidth={2.4} />
        </button>
      </section>

      {/* ── 6. Closing CTA band (opt-in) ────────────────────────────── */}
      {props.showClosingCta && (props.ctaBand.title || props.ctaBand.ctaLabel) && (
        <section className="flex flex-col items-start gap-4 rounded-[36px] bg-foreground p-8 text-background sm:p-12">
          {props.ctaBand.eyebrow && (
            <span className="eyebrow text-background/60">{props.ctaBand.eyebrow}</span>
          )}
          {props.ctaBand.title && (
            <h2 className="text-[clamp(26px,3vw,40px)] font-extrabold tracking-[-0.03em]">{props.ctaBand.title}</h2>
          )}
          {props.ctaBand.subtitle && (
            <p className="max-w-[60ch] text-[16px] leading-relaxed text-background/70">{props.ctaBand.subtitle}</p>
          )}
          {props.ctaBand.ctaLabel && props.ctaBand.ctaHref && (
            <Link
              href={props.ctaBand.ctaHref}
              className="mt-1 flex h-12 items-center gap-2 rounded-full bg-primary px-6 text-[15px] font-bold text-primary-foreground transition-colors hover:bg-primary-hover"
            >
              {props.ctaBand.ctaLabel}
              <ChevronRight aria-hidden className="size-4" strokeWidth={2.4} />
            </Link>
          )}
        </section>
      )}

      {/* ── 7. FAQ ─────────────────────────────────────────────────── */}
      <section className="flex flex-col gap-6 px-1 pb-10 pt-6">
        <h2 className="text-[clamp(28px,3vw,44px)] font-extrabold tracking-[-0.03em] text-foreground">
          Questions fréquentes
        </h2>
        <div className="grid items-stretch gap-4 [grid-template-columns:repeat(auto-fit,minmax(min(100%,400px),1fr))]">
          <div role="tablist" aria-orientation="vertical" className="grid auto-rows-[72px] gap-2">
            {copy.faqs.map((f, i) => {
              const on = faq === i;
              return (
                <button
                  key={f.q}
                  type="button"
                  role="tab"
                  aria-selected={on}
                  onClick={() => setFaq(i)}
                  className={cn(
                    "grid h-[72px] grid-cols-[32px_minmax(0,1fr)_16px] items-center gap-4 rounded-[24px] pl-5 pr-6 text-left transition-colors",
                    on ? "bg-foreground text-background" : "bg-background text-foreground",
                  )}
                >
                  <span className={cn("grid size-8 place-items-center rounded-full text-[12px] font-extrabold tabular-nums transition-colors", on ? "bg-primary text-primary-foreground" : "bg-secondary text-foreground")}>
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  <span className="line-clamp-2 text-[15px] font-bold leading-5">{f.q}</span>
                  <ChevronRight aria-hidden className={cn("size-4 transition-opacity", on ? "opacity-100" : "opacity-30")} strokeWidth={2.2} />
                </button>
              );
            })}
          </div>
          <div role="tabpanel" className="grid min-h-[312px] rounded-[24px] bg-background p-8">
            {copy.faqs.map((f, i) =>
              faq === i ? (
                <div key={f.q} className="flex flex-col">
                  <span className="eyebrow text-primary">Question {String(i + 1).padStart(2, "0")}</span>
                  <h3 className="mt-3 text-[24px] font-extrabold leading-8 tracking-[-0.02em] text-balance">{f.q}</h3>
                  <p className="mt-4 max-w-[60ch] text-[16px] leading-[26px] text-graphite text-pretty">{f.a}</p>
                  {telHref && (
                    <div className="mt-auto pt-6">
                      <a
                        href={telHref}
                        className="flex h-12 items-center justify-between gap-4 rounded-full bg-secondary pl-5 pr-2 text-[14px] text-foreground transition-colors hover:bg-primary/10"
                      >
                        <span>Une autre question ?</span>
                        <span className="flex h-8 items-center gap-2 rounded-full bg-foreground px-3.5 font-bold text-background">
                          <Phone aria-hidden className="size-3.5" strokeWidth={2} />
                          {phone}
                        </span>
                      </a>
                    </div>
                  )}
                </div>
              ) : null,
            )}
          </div>
        </div>
      </section>
    </div>
  );
}

/* ── Collapsible sidebar group ─────────────────────────────────────── */
function FilterGroup({
  label,
  state,
  children,
}: {
  label: string;
  state: { open: boolean; toggle: () => void };
  children: ReactNode;
}) {
  return (
    <div className="border-t border-border/70">
      <button
        type="button"
        onClick={state.toggle}
        className="flex h-14 w-full items-center justify-between gap-3 text-left text-[15px] font-extrabold text-foreground"
      >
        {label}
        <ChevronRight aria-hidden className={cn("size-4 transition-transform", state.open ? "rotate-90" : "-rotate-90")} strokeWidth={2.2} />
      </button>
      <div className={cn("grid transition-[grid-template-rows] duration-300", state.open ? "grid-rows-[1fr]" : "grid-rows-[0fr]")}>
        <div className="overflow-hidden">
          <div className="pb-5">{children}</div>
        </div>
      </div>
    </div>
  );
}

function PriceField({
  label,
  value,
  placeholder,
  onChange,
}: {
  label: string;
  value: string;
  placeholder: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="flex h-[52px] flex-col justify-center gap-0.5 rounded-2xl border border-border bg-secondary/40 px-3.5">
      <span className="eyebrow text-muted-foreground">{label}</span>
      <span className="flex items-center gap-1">
        <input
          type="number"
          inputMode="numeric"
          placeholder={placeholder}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="w-full min-w-0 border-0 bg-transparent p-0 text-[15px] font-bold text-foreground outline-none"
        />
        <span className="text-[12px] text-muted-foreground">TND</span>
      </span>
    </label>
  );
}

/* ── Rayons (coarse product-type) pill rail with collapse ──────────── */
function RayonsRail({
  rayons,
  active,
  title,
  allLabel,
  onPick,
}: {
  rayons: { key: string; count: number; img: string }[];
  active: string;
  title: string;
  allLabel: string;
  onPick: (key: string) => void;
}) {
  const railRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [hidden, setHidden] = useState(0);

  const total = rayons.reduce((a, r) => a + r.count, 0);
  const pills = [
    { key: "all", label: allLabel, count: total, img: rayons[0]?.img ?? "" },
    ...rayons.map((r) => ({ ...r, label: r.key })),
  ];

  useEffect(() => {
    const rail = railRef.current;
    if (!rail) return;
    const measure = () => {
      const kids = Array.from(rail.children) as HTMLElement[];
      if (kids.length === 0) return setHidden(0);
      const cap = kids[0].offsetTop + kids[0].offsetHeight + 6;
      setHidden(kids.filter((k) => k.offsetTop >= cap).length);
    };
    measure();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    ro?.observe(rail);
    return () => ro?.disconnect();
  }, [rayons]);

  const collapsible = hidden > 0;

  return (
    <div className="flex flex-col gap-3 border-t border-border/70 pt-5">
      <div className="flex items-center justify-between gap-3">
        <span className="text-[13px] font-extrabold uppercase tracking-[0.12em] text-muted-foreground">
          {title} <span className="text-foreground">· {rayons.length}</span>
        </span>
        {collapsible && (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="h-10 rounded-full bg-secondary px-4 text-[13px] font-bold text-foreground transition-colors hover:bg-foreground hover:text-background"
          >
            {expanded ? "Réduire" : `Tout afficher (+${hidden})`}
          </button>
        )}
      </div>
      <div
        ref={railRef}
        className="flex flex-wrap gap-2 overflow-hidden transition-[max-height] duration-500"
        style={{ maxHeight: expanded || !collapsible ? 2000 : 60 }}
      >
        {pills.map((p) => {
          const on = active === p.key;
          return (
            <button
              key={p.key}
              type="button"
              onClick={() => onPick(p.key)}
              className={cn(
                "flex h-14 shrink-0 items-center gap-2.5 rounded-full py-0 pl-1.5 pr-[18px] transition-colors",
                on ? "bg-foreground text-background" : "bg-secondary text-foreground hover:brightness-[0.97]",
              )}
            >
              <span className="size-11 shrink-0 overflow-hidden rounded-full bg-background">
                <span
                  className="block size-full bg-cover bg-center"
                  style={{ backgroundImage: `url(${p.img})` }}
                />
              </span>
              <span className="flex flex-col items-start">
                <span className="whitespace-nowrap text-[15px] font-bold">{p.label}</span>
                <span className="whitespace-nowrap text-[11px] opacity-70">
                  {p.count} produit{p.count > 1 ? "s" : ""}
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* ── Collection product card (real favorites + cart + link) ────────── */
function CollectionCard({
  product,
  extra,
  strategy,
  rank,
  sold,
  days,
}: {
  product: Product;
  extra?: CollectionCardExtra;
  strategy: CollectionStrategy;
  rank?: number;
  sold: number;
  days: number | null;
}) {
  const { price, strike, off, save } = pricingOf(product, extra);
  const { rating, reviews } = productRating(product);
  const stock = stockState(product);
  const oos = stock === "out_of_stock";
  const preorder = stock === "backorder";
  const wished = useIsFavorite(product.slug);
  const [added, setAdded] = useState(false);
  const imgRef = useRef<HTMLImageElement>(null);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    const img = imgRef.current;
    if (img?.complete && img.naturalWidth > 0) setLoaded(true);
  }, []);

  const topRank = strategy === "best_sellers" ? rank : undefined;

  return (
    <article className="group relative flex h-full w-full flex-col gap-2.5 rounded-card border border-border bg-background p-2 transition-[transform,box-shadow] duration-200 hover:-translate-y-1 hover:shadow-island">
      <div className="relative aspect-square overflow-hidden rounded-media bg-product-media">
        <Link href={`/${product.slug}`} className="absolute inset-0 block">
          <div className={cn("size-full", !loaded && "animate-pulse bg-secondary")}>
            <img
              ref={imgRef}
              src={product.image}
              alt=""
              loading="lazy"
              decoding="async"
              onLoad={() => setLoaded(true)}
              onError={() => setLoaded(true)}
              className={cn("size-full object-contain", !oos ? "opacity-100" : "opacity-55")}
            />
          </div>
          {/* Top-left badge: rank (Top ventes) / discount (Promo) / Nouveau|Bientôt (Nouveautés) */}
          {topRank != null && sold > 0 && (
            <span
              className={cn(
                "absolute left-2 top-2 grid h-9 min-w-9 place-items-center rounded-full px-2.5 text-[15px] font-black tabular-nums",
                topRank <= 3 ? "bg-primary text-primary-foreground" : "bg-background text-foreground",
              )}
            >
              #{topRank}
            </span>
          )}
          {strategy === "on_promotion" && strike && (
            <span className="absolute left-2 top-2 flex h-[30px] items-center rounded-full bg-primary px-3 text-[14px] font-black text-primary-foreground">
              −{off}&nbsp;%
            </span>
          )}
          {strategy === "new_arrivals" && (preorder || (days != null && days <= 7)) && (
            <span
              className={cn(
                "absolute left-2 top-2 flex h-9 items-center rounded-full px-2.5 text-[13px] font-black",
                preorder ? "bg-foreground text-background" : "bg-primary text-primary-foreground",
              )}
            >
              {preorder ? "Bientôt" : "Nouveau"}
            </span>
          )}
          {/* Top-ventes also shows a small discount chip when the best-seller is on sale. */}
          {strategy === "best_sellers" && strike && (
            <span className="absolute bottom-2 left-2 flex h-[26px] items-center rounded-full bg-primary px-2.5 text-[12px] font-extrabold text-primary-foreground">
              −{off}&nbsp;%
            </span>
          )}
        </Link>
        <button
          type="button"
          onClick={() => toggleFavorite(product.slug)}
          aria-pressed={wished}
          aria-label={wished ? "Retirer des favoris" : "Ajouter aux favoris"}
          className={cn(
            "absolute right-2 top-2 z-10 grid size-9 place-items-center rounded-full border border-border bg-background/90 backdrop-blur transition-colors hover:border-primary/40",
            wished ? "text-primary" : "text-foreground hover:text-primary",
          )}
        >
          <Heart aria-hidden className={cn("size-4", wished && "fill-current")} strokeWidth={2} />
        </button>
      </div>

      <div className="flex flex-1 flex-col gap-2 px-1.5">
        <span className="eyebrow truncate text-muted-foreground">{product.brand || "Tokyo Store"}</span>
        <Link
          href={`/${product.slug}`}
          className="line-clamp-2 min-h-[38px] text-sm font-bold leading-[1.35] text-foreground transition-colors hover:text-primary"
        >
          {product.title}
        </Link>
        <div className="flex flex-wrap gap-1.5">
          {rating ? (
            <span className="flex items-center gap-1 rounded-full bg-secondary px-2.5 py-1 text-[11px] text-graphite">
              <Star aria-hidden className="size-2.5 fill-rating text-rating" /> {rating}
              <span className="text-muted-foreground">({reviews})</span>
            </span>
          ) : (
            <span className="flex items-center gap-1 rounded-full bg-muted px-2.5 py-1 text-[11px] text-muted-foreground">
              <Star aria-hidden className="size-2.5" /> Aucun avis
            </span>
          )}
          <span
            className={cn(
              "flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold",
              oos ? "bg-muted text-muted-foreground" : preorder ? "bg-primary/10 text-primary-ink" : "bg-success/10 text-success",
            )}
          >
            <span className={cn("size-1.5 rounded-full", oos ? "bg-muted-foreground" : preorder ? "bg-primary" : "bg-success")} />
            {STOCK_LABEL[stock]}
          </span>
        </div>
        <div className="mt-0.5 flex flex-wrap items-baseline gap-2">
          <span className="text-[20px] font-extrabold leading-none tracking-[-0.01em] text-primary">
            {fmtPrice(price)} <span className="text-[11px] font-bold">TND</span>
          </span>
          {strike && (
            <span className="text-[13px] text-muted-foreground line-through tabular-nums">{fmtPrice(strike)}</span>
          )}
        </div>
        {/* Per-strategy stat line */}
        {strategy === "best_sellers" && sold > 0 && (
          <span className="text-[12px] font-bold text-graphite">{fmtPrice(sold)} vendus</span>
        )}
        {strategy === "on_promotion" && save > 0 && (
          <span className="flex h-6 w-fit items-center rounded-full bg-success/10 px-2.5 text-[12px] font-extrabold text-success">
            Économisez {fmtPrice(save)} TND
          </span>
        )}
        {strategy === "new_arrivals" && (
          <span
            className={cn(
              "flex h-6 w-fit items-center rounded-full px-2.5 text-[12px] font-bold",
              !preorder && days != null && days <= 7
                ? "bg-success/10 text-success"
                : "bg-secondary text-graphite",
            )}
          >
            {preorder ? "Prochainement" : agoLabel(days)}
          </span>
        )}
      </div>

      <button
        type="button"
        onClick={() => {
          if (oos) return;
          addToCart(product.slug, 1);
          setAdded(true);
          setTimeout(() => setAdded(false), 1500);
        }}
        disabled={oos}
        className={cn(
          "flex h-11 w-full items-center justify-center gap-2 rounded-full border-[1.5px] text-[13px] font-bold transition-colors",
          oos
            ? "border-foreground bg-background text-foreground disabled:opacity-100"
            : added
              ? "border-success bg-success text-success-foreground"
              : "border-foreground bg-foreground text-background hover:bg-primary hover:border-primary",
        )}
      >
        {oos ? (
          "Indisponible"
        ) : added ? (
          <>
            <Check aria-hidden className="size-4" /> Ajouté
          </>
        ) : preorder ? (
          <>
            <Bell aria-hidden className="size-4" strokeWidth={2.2} /> Précommander
          </>
        ) : (
          <>
            <ShoppingBag aria-hidden className="size-4" strokeWidth={2.2} /> Ajouter au panier
          </>
        )}
      </button>
    </article>
  );
}
