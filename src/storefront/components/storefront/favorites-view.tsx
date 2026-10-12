"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  ArrowDown,
  Bell,
  Check,
  CheckCheck,
  ChevronRight,
  CreditCard,
  Heart,
  House,
  LayoutGrid,
  List as ListIcon,
  RefreshCw,
  ShieldCheck,
  ShoppingBag,
  Trash2,
  Truck,
} from "lucide-react";

import { SelectField } from "@/components/ui/select-field";
import { EmptyState } from "@/storefront/components/storefront/empty-state";
import { PendingBody } from "@/storefront/components/storefront/pending-body";
import { CatalogProductCard } from "@/storefront/components/storefront/product-card";
import { RailArrow } from "@/storefront/components/storefront/rail-arrow";
import { btn, chip, rhythm } from "@/storefront/components/storefront/ui-classes";
import { addToCart } from "@/storefront/lib/cart";
import type { Product } from "@/storefront/lib/catalog";
import {
  favoriteProducts,
  removeFavorite,
  toggleFavorite,
  useFavorites,
  useFavoritesReady,
  useIsFavorite,
} from "@/storefront/lib/favorites";
import { useHydrated } from "@/storefront/lib/hydration";
import {
  STOCK_LABEL,
  conditionLabel,
  fmtPrice,
  isOrderable,
  productStrike,
  stockState,
} from "@/storefront/lib/productMeta";
import { cn } from "@/storefront/lib/utils";

type Filter = "all" | "stock" | "drop" | "out";
type Sort = "recent" | "asc" | "desc" | "drop";

const FILTERS: { key: Filter; label: string }[] = [
  { key: "all", label: "Tous" },
  { key: "stock", label: "En stock" },
  { key: "drop", label: "Prix en baisse" },
  { key: "out", label: "En rupture" },
];

const SORTS: { value: Sort; label: string }[] = [
  { value: "recent", label: "Ajout récent" },
  { value: "asc", label: "Prix croissant" },
  { value: "desc", label: "Prix décroissant" },
  { value: "drop", label: "Plus grosse baisse" },
];

function matches(p: Product, f: Filter): boolean {
  if (f === "all") return true;
  if (f === "stock") return stockState(p) === "in_stock";
  if (f === "drop") return productStrike(p) !== null;
  return stockState(p) === "out_of_stock"; // "out"
}

const SORTERS: Record<Sort, ((a: Product, b: Product) => number) | null> = {
  recent: null, // store order is already newest-first
  asc: (a, b) => a.price - b.price,
  desc: (a, b) => b.price - a.price,
  drop: (a, b) => {
    const sa = productStrike(a);
    const sb = productStrike(b);
    return (sb ? sb.strike - b.price : 0) - (sa ? sa.strike - a.price : 0);
  },
};

export function FavoritesView({ recommendations = [] }: { recommendations?: Product[] }) {
  const hydrated = useHydrated();
  const ready = useFavoritesReady();
  const slugs = useFavorites();
  const items = favoriteProducts(slugs);
  const n = items.length;

  const [filter, setFilter] = useState<Filter>("all");
  const [sort, setSort] = useState<Sort>("recent");
  const [view, setView] = useState<"grid" | "list">("grid");
  const [selecting, setSelecting] = useState(false);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [added, setAdded] = useState<Record<string, boolean>>({});
  const [addAllDone, setAddAllDone] = useState(false);

  // List view is only legible from ~760px up; below that it falls back to grid.
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const on = () => setNarrow(window.innerWidth < 760);
    on();
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  const listView = view === "list" && !narrow;

  /* Floating client-only feedback: a success toast after an add, an undo
     snackbar after a removal (re-adds via the same backend toggle). */
  const [toast, setToast] = useState<string | null>(null);
  const [undo, setUndo] = useState<{ slugs: string[]; label: string } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const undoTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const addedTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  useEffect(
    () => () => {
      clearTimeout(toastTimer.current);
      clearTimeout(undoTimer.current);
      Object.values(addedTimers.current).forEach(clearTimeout);
    },
    [],
  );

  const showToast = (text: string) => {
    setToast(text);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3200);
  };
  const showUndo = (removed: string[], label: string) => {
    if (!removed.length) return;
    setUndo({ slugs: removed, label });
    clearTimeout(undoTimer.current);
    undoTimer.current = setTimeout(() => setUndo(null), 5000);
  };

  // Derived stats — computed off the RESOLVED items (a favourited product that
  // left the catalog is silently dropped by favoriteProducts, so counts here
  // always match what is rendered).
  const { total, drops, saved, outs, orderable, counts } = useMemo(() => {
    const dropItems = items.filter((p) => productStrike(p) !== null);
    const savedSum = dropItems.reduce((t, p) => {
      const s = productStrike(p);
      return t + (s ? s.strike - p.price : 0);
    }, 0);
    return {
      total: items.reduce((t, p) => t + p.price, 0),
      drops: dropItems,
      saved: savedSum,
      outs: items.filter((p) => stockState(p) === "out_of_stock"),
      orderable: items.filter((p) => isOrderable(p)),
      counts: {
        all: items.length,
        stock: items.filter((p) => stockState(p) === "in_stock").length,
        drop: dropItems.length,
        out: items.filter((p) => stockState(p) === "out_of_stock").length,
      } as Record<Filter, number>,
    };
  }, [items]);

  const shown = useMemo(() => {
    const list = items.filter((p) => matches(p, filter));
    const sorter = SORTERS[sort];
    return sorter ? [...list].sort(sorter) : list;
  }, [items, filter, sort]);

  const allShownSelected = shown.length > 0 && shown.every((p) => sel.has(p.slug));

  /* ── actions (all wired to the real backend stores) ───────────────────── */
  const flashAdded = (slug: string) => {
    setAdded((prev) => ({ ...prev, [slug]: true }));
    clearTimeout(addedTimers.current[slug]);
    addedTimers.current[slug] = setTimeout(
      () => setAdded((prev) => ({ ...prev, [slug]: false })),
      1800,
    );
  };
  const addOne = (p: Product) => {
    addToCart(p.slug, 1);
    flashAdded(p.slug);
    showToast(p.title);
  };
  const removeOne = (p: Product) => {
    removeFavorite(p.slug);
    setSel((prev) => {
      const next = new Set(prev);
      next.delete(p.slug);
      return next;
    });
    showUndo([p.slug], `« ${p.title} » retiré des favoris`);
  };
  const toggleSel = (slug: string) =>
    setSel((prev) => {
      const next = new Set(prev);
      if (next.has(slug)) next.delete(slug);
      else next.add(slug);
      return next;
    });
  const toggleSelectAll = () =>
    setSel(allShownSelected ? new Set() : new Set(shown.map((p) => p.slug)));
  const removeSelected = () => {
    const picked = [...sel];
    if (!picked.length) return;
    picked.forEach(removeFavorite);
    setSel(new Set());
    showUndo(
      picked,
      picked.length > 1
        ? `${picked.length} produits retirés des favoris`
        : "1 produit retiré des favoris",
    );
  };
  const addSelected = () => {
    const picked = items.filter((p) => sel.has(p.slug) && isOrderable(p));
    picked.forEach((p) => addToCart(p.slug, 1));
    if (picked.length)
      showToast(
        `${picked.length} produit${picked.length > 1 ? "s" : ""} ajouté${picked.length > 1 ? "s" : ""} au panier`,
      );
    setSelecting(false);
    setSel(new Set());
  };
  const addAll = () => {
    if (!orderable.length) return;
    orderable.forEach((p) => addToCart(p.slug, 1));
    setAddAllDone(true);
    showToast(`${orderable.length} produit${orderable.length > 1 ? "s" : ""} ajouté${orderable.length > 1 ? "s" : ""} au panier`);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3200);
    setTimeout(() => setAddAllDone(false), 2400);
  };
  const undoRemove = () => {
    if (!undo) return;
    undo.slugs.forEach(toggleFavorite); // removed → toggling re-adds
    setUndo(null);
  };

  const headerReady = hydrated && ready;

  return (
    <div className="page-container flex flex-col gap-5 pt-3">
      {/* ── Header ── */}
      <section className="flex flex-col gap-7 rounded-[36px] bg-background p-6 sm:p-9 lg:p-12">
        <nav
          aria-label="Fil d'Ariane"
          className="flex min-w-0 items-center gap-1.5 overflow-hidden"
        >
          <Link
            href="/"
            aria-label="Accueil"
            className="grid size-[30px] shrink-0 place-items-center rounded-full bg-secondary text-foreground transition-colors hover:bg-primary/10 hover:text-primary"
          >
            <House aria-hidden className="size-3.5" strokeWidth={2} />
          </Link>
          <ChevronRight aria-hidden className="size-3 shrink-0 text-muted-foreground/50" strokeWidth={2.4} />
          <Link
            href="/account"
            className="px-0.5 py-1 text-[13px] text-muted-foreground transition-colors hover:text-primary"
          >
            Mon compte
          </Link>
          <ChevronRight aria-hidden className="size-3 shrink-0 text-muted-foreground/50" strokeWidth={2.4} />
          <span
            aria-current="page"
            className="shrink-0 rounded-full bg-primary/10 px-3 py-1.5 text-[13px] font-semibold text-primary"
          >
            Favoris
          </span>
        </nav>

        <div className="flex flex-wrap items-end justify-between gap-x-12 gap-y-6">
          <div className="flex min-w-0 flex-[1_1_420px] flex-col gap-3.5">
            <div className="flex flex-wrap items-center gap-4">
              <h1 className="text-[clamp(40px,6.5vw,88px)] font-black leading-[0.92] tracking-[-0.05em] text-foreground">
                Mes favoris
              </h1>
              <span
                aria-hidden
                className="grid size-14 flex-none place-items-center rounded-full bg-primary text-primary-foreground"
              >
                <Heart className="size-6" fill="currentColor" />
              </span>
            </div>
            {headerReady && (
              <p
                role="status"
                className="max-w-[60ch] text-[16px] leading-relaxed text-graphite text-pretty"
              >
                {n > 0 ? (
                  <>
                    <span className="font-semibold text-foreground">{n}</span> produit
                    {n > 1 ? "s" : ""} enregistré{n > 1 ? "s" : ""} · retrouvez ici tout ce que
                    vous aimez.
                  </>
                ) : (
                  "Touchez le cœur sur une fiche produit pour retrouver ici tout ce que vous aimez."
                )}
              </p>
            )}
          </div>
          {headerReady && n > 0 && (
            <button
              type="button"
              onClick={addAll}
              disabled={!orderable.length}
              className={cn(
                "flex h-14 items-center gap-2.5 rounded-full px-6 text-[15px] font-bold text-primary-foreground shadow-cta transition-[filter] hover:brightness-95 disabled:opacity-50",
                addAllDone ? "bg-success" : "bg-primary",
              )}
            >
              {addAllDone ? (
                <>
                  <Check aria-hidden className="size-[18px]" /> Ajoutés au panier
                </>
              ) : (
                <>
                  <ShoppingBag aria-hidden className="size-[18px]" /> Tout ajouter ({orderable.length})
                </>
              )}
            </button>
          )}
        </div>

        {/* ── Stat cards (inside the header card, per the mockup) ── */}
        {headerReady && n > 0 && (
          <div className="grid gap-2.5 [grid-template-columns:repeat(auto-fit,minmax(min(100%,220px),1fr))]">
            <div className="flex items-center gap-3.5 rounded-[24px] bg-foreground p-[18px] text-background">
              <span className="grid size-11 flex-none place-items-center rounded-[14px] bg-primary text-primary-foreground">
                <ShoppingBag aria-hidden className="size-5" />
              </span>
              <span className="flex min-w-0 flex-col">
                <span className="text-[12px] font-semibold text-background/70">
                  Valeur de la liste
                </span>
                <span className="text-[22px] font-black tracking-tight tabular-nums">
                  {fmtPrice(total)} <span className="text-xs font-bold">TND</span>
                </span>
              </span>
            </div>

            <button
              type="button"
              onClick={() => setFilter("drop")}
              className="flex items-center gap-3.5 rounded-[24px] bg-success/10 p-[18px] text-left transition-[filter] hover:brightness-[0.98]"
            >
              <span className="grid size-11 flex-none place-items-center rounded-[14px] bg-success text-success-foreground">
                <ArrowDown aria-hidden className="size-5" />
              </span>
              <span className="flex min-w-0 flex-col">
                <span className="text-[12px] font-bold text-success">Baisses de prix</span>
                <span className="truncate text-sm font-extrabold text-foreground">
                  {drops.length
                    ? `${drops.length} produit${drops.length > 1 ? "s" : ""} · −${fmtPrice(saved)} TND`
                    : "Aucune pour l'instant"}
                </span>
              </span>
            </button>

            <button
              type="button"
              onClick={() => setFilter("out")}
              className="flex items-center gap-3.5 rounded-[24px] bg-secondary p-[18px] text-left transition-[filter] hover:brightness-[0.98]"
            >
              <span className="grid size-11 flex-none place-items-center rounded-[14px] bg-background text-foreground">
                <Bell aria-hidden className="size-5" />
              </span>
              <span className="flex min-w-0 flex-col">
                <span className="text-[12px] font-bold text-muted-foreground">
                  Bientôt de retour
                </span>
                <span className="truncate text-sm font-extrabold text-foreground">
                  {outs.length
                    ? `${outs.length} produit${outs.length > 1 ? "s" : ""} en rupture`
                    : "Tout est en stock"}
                </span>
              </span>
            </button>
          </div>
        )}
      </section>

      {!hydrated || !ready ? (
        <PendingBody />
      ) : (
        <div className={cn("flex flex-col", rhythm.gap)}>
            {n === 0 ? (
              <EmptyState
                icon={Heart}
                title="Votre liste est vide"
                actions={
                  <Link href="/" className={cn(btn.base, btn.lg, btn.primary)}>
                    Découvrir nos produits
                  </Link>
                }
              >
                Touchez le cœur sur une fiche produit pour la retrouver ici.
              </EmptyState>
            ) : (
              <>
                {/* ── Toolbar ── */}
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-island border border-border bg-background p-2 shadow-island">
                  <div className="flex min-w-0 items-center gap-1.5 overflow-x-auto no-scrollbar">
                    {FILTERS.map(({ key, label }) => {
                      const active = filter === key;
                      return (
                        <button
                          key={key}
                          type="button"
                          aria-pressed={active}
                          onClick={() => setFilter(key)}
                          className={cn(
                            "inline-flex h-11 shrink-0 items-center gap-2 rounded-full px-4 text-sm font-semibold transition-colors",
                            active
                              ? "bg-foreground text-background"
                              : "bg-secondary text-foreground hover:text-primary",
                          )}
                        >
                          {label}
                          <span
                            className={cn(
                              "inline-flex h-5 min-w-[22px] items-center justify-center rounded-full px-1.5 text-[11px] font-bold tabular-nums",
                              active
                                ? "bg-primary text-primary-foreground"
                                : "bg-background text-muted-foreground",
                            )}
                          >
                            {counts[key]}
                          </span>
                        </button>
                      );
                    })}
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        setSelecting((v) => !v);
                        setSel(new Set());
                      }}
                      className={cn(btn.base, btn.sm, selecting ? btn.ink : btn.outline)}
                    >
                      <CheckCheck aria-hidden className="size-4" />
                      {selecting ? "Terminer" : "Sélectionner"}
                    </button>

                    <SortSelect value={sort} onChange={setSort} />

                    {/* Grid/List segmented switch — hidden below the list breakpoint. */}
                    <div
                      role="radiogroup"
                      aria-label="Affichage"
                      className="relative hidden grid-cols-[44px_44px] rounded-full bg-secondary p-[3px] min-[760px]:inline-grid"
                    >
                      <span
                        aria-hidden
                        className={cn(
                          "absolute left-[3px] top-[3px] h-[38px] w-11 rounded-full bg-background shadow-sm transition-transform duration-300",
                          view === "list" && "translate-x-11",
                        )}
                      />
                      <button
                        type="button"
                        role="radio"
                        aria-checked={view === "grid"}
                        aria-label="Grille"
                        onClick={() => setView("grid")}
                        className={cn(
                          "relative grid h-[38px] place-items-center transition-colors",
                          view === "grid" ? "text-foreground" : "text-muted-foreground",
                        )}
                      >
                        <LayoutGrid aria-hidden className="size-[17px]" />
                      </button>
                      <button
                        type="button"
                        role="radio"
                        aria-checked={view === "list"}
                        aria-label="Liste"
                        onClick={() => setView("list")}
                        className={cn(
                          "relative grid h-[38px] place-items-center transition-colors",
                          view === "list" ? "text-foreground" : "text-muted-foreground",
                        )}
                      >
                        <ListIcon aria-hidden className="size-[17px]" />
                      </button>
                    </div>
                  </div>
                </div>

                {/* ── Selection bar ── */}
                {selecting && (
                  <div className="sticky top-[calc(var(--nav-h)+0.5rem)] z-20 flex flex-wrap items-center justify-between gap-2 rounded-island bg-foreground px-3 py-2 text-background shadow-island sm:px-4">
                    <button
                      type="button"
                      onClick={toggleSelectAll}
                      className="inline-flex items-center gap-2.5 text-sm font-semibold"
                    >
                      <span
                        className={cn(
                          "grid size-6 flex-none place-items-center rounded-lg border transition-colors",
                          allShownSelected
                            ? "border-primary bg-primary text-primary-foreground"
                            : "border-background/50 text-transparent",
                        )}
                      >
                        <Check aria-hidden className="size-3.5" />
                      </span>
                      {sel.size
                        ? `${sel.size} sélectionné${sel.size > 1 ? "s" : ""}`
                        : "Tout sélectionner"}
                    </button>
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={removeSelected}
                        disabled={!sel.size}
                        className={cn(
                          btn.base,
                          btn.sm,
                          "border border-background/20 bg-transparent text-background hover:bg-background/10 disabled:opacity-40",
                        )}
                      >
                        <Trash2 aria-hidden className="size-4" /> Retirer
                      </button>
                      <button
                        type="button"
                        onClick={addSelected}
                        disabled={!sel.size}
                        className={cn(btn.base, btn.sm, btn.primary, "disabled:opacity-40")}
                      >
                        <ShoppingBag aria-hidden className="size-4" /> Ajouter au panier
                      </button>
                    </div>
                  </div>
                )}

                {/* ── Items ── */}
                {shown.length > 0 ? (
                  <section
                    className={cn(
                      listView
                        ? "grid grid-cols-1 gap-3"
                        : cn(
                            "grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 2xl:grid-cols-6",
                            rhythm.gap,
                          ),
                    )}
                  >
                    {shown.map((p) => (
                      <FavoriteCard
                        key={p.slug}
                        product={p}
                        list={listView}
                        selecting={selecting}
                        selected={sel.has(p.slug)}
                        added={!!added[p.slug]}
                        onToggleSel={() => toggleSel(p.slug)}
                        onRemove={() => removeOne(p)}
                        onAdd={() => addOne(p)}
                      />
                    ))}
                  </section>
                ) : (
                  <div className="flex flex-col items-center gap-3 rounded-island border border-border bg-background px-6 py-12 text-center shadow-island">
                    <p className="text-lg font-extrabold text-foreground">
                      Aucun favori dans ce filtre
                    </p>
                    <button
                      type="button"
                      onClick={() => setFilter("all")}
                      className={cn(btn.base, btn.md, btn.ink)}
                    >
                      Voir tous mes favoris
                    </button>
                  </div>
                )}
              </>
            )}

            {/* ── Recommendations ── */}
            {recommendations.length > 0 && <RecoRail items={recommendations} />}

            {/* ── Service band ── */}
            <section className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-5 rounded-island bg-foreground p-6 text-background lg:p-8">
              <ServiceItem
                icon={<Truck aria-hidden className="size-5" />}
                title="Livraison 24h"
                sub="Partout en Tunisie"
              />
              <ServiceItem
                icon={<ShieldCheck aria-hidden className="size-5" />}
                title="Garantie 12 mois"
                sub="Neuf — garantie constructeur"
              />
              <ServiceItem
                icon={<CreditCard aria-hidden className="size-5" />}
                title="Paiement à la livraison"
                sub="Ou carte bancaire"
              />
              <ServiceItem
                icon={<RefreshCw aria-hidden className="size-5" />}
                title="Reprise immédiate"
                sub="Estimation gratuite"
              />
            </section>
          </div>
      )}

      {/* ── Floating toast (add-to-cart success) ── */}
      <div
        role="status"
        aria-live="polite"
        className={cn(
          "fixed right-4 top-4 z-50 w-[min(360px,calc(100%-32px))] items-center gap-3 rounded-island bg-foreground p-3.5 text-background shadow-island transition-all duration-300",
          toast ? "flex translate-y-0 opacity-100" : "pointer-events-none hidden -translate-y-3 opacity-0",
        )}
      >
        <span className="grid size-9 flex-none place-items-center rounded-full bg-success text-success-foreground">
          <Check aria-hidden className="size-4" />
        </span>
        <div className="min-w-0">
          <div className="text-sm font-bold">Ajouté au panier</div>
          <div className="truncate text-[13px] text-background/70">{toast}</div>
        </div>
        <Link
          href="/panier"
          className="ml-auto inline-flex h-9 flex-none items-center rounded-full bg-primary px-3.5 text-[13px] font-bold text-primary-foreground"
        >
          Voir le panier
        </Link>
      </div>

      {/* ── Undo snackbar (after removal) ── */}
      <div
        role="status"
        aria-live="polite"
        className={cn(
          "fixed bottom-[calc(var(--dock-bottom)+0.5rem)] left-1/2 z-50 w-[min(460px,calc(100%-24px))] -translate-x-1/2 items-center gap-3 rounded-full bg-foreground py-2 pl-5 pr-2 text-background shadow-island transition-all duration-300 md:bottom-5",
          undo ? "flex translate-y-0 opacity-100" : "pointer-events-none hidden translate-y-4 opacity-0",
        )}
      >
        <span className="min-w-0 flex-1 truncate text-sm">{undo?.label}</span>
        <button
          type="button"
          onClick={undoRemove}
          className="inline-flex h-10 flex-none items-center rounded-full bg-background px-4 text-sm font-bold text-foreground"
        >
          Annuler
        </button>
      </div>
    </div>
  );
}

/* Sort control — the shared themed listbox (portals + re-roots the crimson
   scope), kept compact for the toolbar. */
function SortSelect({ value, onChange }: { value: Sort; onChange: (v: Sort) => void }) {
  return (
    <SelectField
      size="sm"
      ariaLabel="Trier par"
      value={value}
      onChange={(v: string) => onChange(v as Sort)}
      options={SORTS}
      className="w-[172px]"
    />
  );
}

function ServiceItem({
  icon,
  title,
  sub,
}: {
  icon: React.ReactNode;
  title: string;
  sub: string;
}) {
  return (
    <div className="flex items-start gap-3.5">
      <span className="grid size-11 flex-none place-items-center rounded-[14px] bg-primary text-primary-foreground">
        {icon}
      </span>
      <div>
        <div className="font-display text-[15px] font-bold">{title}</div>
        <div className="mt-1 text-[13px] text-background/70">{sub}</div>
      </div>
    </div>
  );
}

function StockChip({ product }: { product: Product }) {
  const stock = stockState(product);
  return (
    <span
      className={cn(
        "inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-[11px] font-semibold",
        stock === "out_of_stock"
          ? "bg-muted text-muted-foreground"
          : stock === "backorder"
            ? "bg-primary/10 text-primary-ink"
            : "bg-success/10 text-success",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "size-1.5 rounded-full",
          stock === "out_of_stock"
            ? "bg-muted-foreground"
            : stock === "backorder"
              ? "bg-primary"
              : "bg-success",
        )}
      />
      {STOCK_LABEL[stock]}
    </span>
  );
}

function FavoriteCard({
  product,
  list,
  selecting,
  selected,
  added,
  onToggleSel,
  onRemove,
  onAdd,
}: {
  product: Product;
  list: boolean;
  selecting: boolean;
  selected: boolean;
  added: boolean;
  onToggleSel: () => void;
  onRemove: () => void;
  onAdd: () => void;
}) {
  const strike = productStrike(product);
  const orderable = isOrderable(product);
  const oos = !orderable;
  const saving = strike ? strike.strike - product.price : 0;

  const media = (
    <div
      className={cn(
        "relative overflow-hidden rounded-media bg-product-media",
        list ? "w-[132px] flex-none" : "w-full",
      )}
    >
      <Link href={`/${product.slug}`} className="block aspect-square p-3">
        <img
          src={product.image}
          alt=""
          loading="lazy"
          decoding="async"
          className={cn("h-full w-full object-contain", oos && "opacity-60")}
        />
      </Link>

      {/* Overlay badge: current compare-at discount, else a rupture tag. */}
      {strike ? (
        <span className="absolute left-2 top-2 inline-flex h-6 items-center rounded-full bg-success px-2.5 text-[12px] font-bold text-success-foreground">
          −{strike.pct}%
        </span>
      ) : oos ? (
        <span className="absolute left-2 top-2 inline-flex h-6 items-center rounded-full bg-muted px-2.5 text-[12px] font-semibold text-muted-foreground">
          Rupture
        </span>
      ) : null}

      {/* Remove heart — hidden while selecting. */}
      {!selecting && (
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Retirer ${product.title} des favoris`}
          title="Retirer des favoris"
          className="absolute right-2 top-2 grid size-10 place-items-center rounded-full bg-background text-primary shadow-sm transition-transform duration-200 hover:scale-110"
        >
          <Heart aria-hidden className="size-[18px]" fill="currentColor" />
        </button>
      )}

      {/* Selection veil + checkbox. */}
      {selecting && (
        <button
          type="button"
          onClick={onToggleSel}
          aria-label={`${selected ? "Désélectionner" : "Sélectionner"} ${product.title}`}
          aria-pressed={selected}
          className={cn(
            "absolute inset-0 flex items-start justify-end p-2.5 transition-colors",
            selected ? "bg-primary/[0.12]" : "bg-transparent",
          )}
        >
          <span
            className={cn(
              "grid size-6 place-items-center rounded-lg border transition-colors",
              selected
                ? "border-primary bg-primary text-primary-foreground"
                : "border-border bg-background text-transparent",
            )}
          >
            <Check aria-hidden className="size-3.5" />
          </span>
        </button>
      )}
    </div>
  );

  const info = (
    <div className={cn("flex min-w-0 flex-1 flex-col gap-1.5", list ? "" : "px-1.5 pt-3")}>
      <p className="eyebrow truncate text-muted-foreground">{product.brand || "Tokyo Store"}</p>
      <Link
        href={`/${product.slug}`}
        className={cn(
          "line-clamp-2 min-h-[2.5em] font-display font-semibold leading-tight text-foreground transition-colors hover:text-primary",
          list ? "text-[15px]" : "text-[13px] sm:text-sm",
        )}
      >
        {product.title}
      </Link>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className={cn(chip.base, chip.sm, "h-6 border border-border bg-secondary font-medium text-muted-foreground")}>
          {conditionLabel(product.condition)}
        </span>
        <StockChip product={product} />
      </div>
      <div className="mt-auto flex flex-wrap items-baseline gap-x-2 pt-1">
        <span className="text-[21px] font-black leading-none tracking-tight tabular-nums text-primary">
          {fmtPrice(product.price)} <span className="text-[11px] font-bold">TND</span>
        </span>
        {strike && (
          <span className="text-[13px] leading-none text-muted-foreground line-through tabular-nums">
            {fmtPrice(strike.strike)} TND
          </span>
        )}
      </div>
      {saving > 0 && (
        <span className="inline-flex items-center gap-1.5 text-[12px] font-bold text-success">
          <ArrowDown aria-hidden className="size-3" /> Économisez {fmtPrice(saving)} TND
        </span>
      )}
    </div>
  );

  const cta = orderable ? (
    <button
      type="button"
      onClick={onAdd}
      className={cn(
        btn.base,
        btn.sm,
        "w-full",
        added ? "bg-success text-success-foreground" : btn.ink,
      )}
    >
      {added ? (
        <>
          <Check aria-hidden className="size-4" /> Ajouté
        </>
      ) : (
        <>
          <ShoppingBag aria-hidden className="size-4" />
          <span className="sm:hidden">Ajouter</span>
          <span className="hidden sm:inline">Ajouter au panier</span>
        </>
      )}
    </button>
  ) : (
    <Link href={`/${product.slug}`} className={cn(btn.base, btn.sm, btn.outline, "w-full")}>
      Voir le produit
    </Link>
  );

  if (list) {
    return (
      <article
        className={cn(
          "flex flex-row items-center gap-4 rounded-card border bg-background p-2.5 transition-shadow hover:shadow-island",
          selected ? "border-primary" : "border-border",
        )}
      >
        {media}
        {info}
        <div className="flex w-[180px] flex-none flex-col gap-2">
          {cta}
          <button
            type="button"
            onClick={onRemove}
            className={cn(btn.base, btn.sm, btn.outline, "w-full")}
          >
            <Trash2 aria-hidden className="size-4" /> Retirer
          </button>
        </div>
      </article>
    );
  }

  return (
    <article
      className={cn(
        "flex h-full flex-col rounded-card border bg-background p-2.5 transition-shadow hover:shadow-island",
        selected ? "border-primary" : "border-border",
      )}
    >
      {media}
      {info}
      <div className="mt-3">{cta}</div>
    </article>
  );
}

/* Horizontal recommendations rail, server-fed from the real catalog; each card
   carries a heart that toggles the backend wishlist. */
function RecoRail({ items }: { items: Product[] }) {
  const rail = useRef<HTMLDivElement | null>(null);
  const scroll = (dir: number) => {
    const el = rail.current;
    if (el) el.scrollBy({ left: dir * el.clientWidth * 0.8, behavior: "smooth" });
  };
  return (
    <section className="flex flex-col gap-4 pt-4">
      <div className="flex items-end justify-between gap-4">
        <h2 className="title-block text-foreground">Vous aimerez aussi</h2>
        <div className="hidden gap-2 sm:flex">
          <RailArrow direction="prev" label="Précédent" onClick={() => scroll(-1)} />
          <RailArrow direction="next" label="Suivant" onClick={() => scroll(1)} />
        </div>
      </div>
      <div
        ref={rail}
        className="flex gap-3.5 overflow-x-auto no-scrollbar [scroll-snap-type:x_mandatory] pb-1"
      >
        {items.map((p) => (
          <div
            key={p.id ?? p.slug}
            className="relative flex-[0_0_clamp(200px,calc((100%-70px)/6),280px)] [scroll-snap-align:start]"
          >
            <RecoHeart slug={p.slug} />
            <CatalogProductCard product={p} />
          </div>
        ))}
      </div>
    </section>
  );
}

function RecoHeart({ slug }: { slug: string }) {
  const favorited = useIsFavorite(slug);
  return (
    <button
      type="button"
      onClick={() => toggleFavorite(slug)}
      aria-label={favorited ? "Retirer des favoris" : "Ajouter aux favoris"}
      aria-pressed={favorited}
      className={cn(
        "absolute right-[18px] top-[18px] z-10 grid size-10 place-items-center rounded-full border border-border bg-background shadow-sm transition-transform duration-200 hover:scale-110",
        favorited ? "text-primary" : "text-foreground",
      )}
    >
      <Heart aria-hidden className="size-[17px]" fill={favorited ? "currentColor" : "none"} />
    </button>
  );
}
