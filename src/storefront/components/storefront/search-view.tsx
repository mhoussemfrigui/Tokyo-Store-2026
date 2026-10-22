"use client";

import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight, Clock, Search as SearchIcon, TrendingUp, X } from "lucide-react";

import { ListingRegion } from "@/storefront/components/storefront/listing/listing-region";
import { ServiceBand } from "@/storefront/components/storefront/listing/service-band";
import { useProductListing } from "@/storefront/components/storefront/listing/use-listing";
import { products as ALL_PRODUCTS, type Product } from "@/storefront/lib/catalog";
import { taxonomyLabel } from "@/storefront/lib/categoryNav";
import { fmtPrice, stockState } from "@/storefront/lib/productMeta";
import { cn } from "@/storefront/lib/utils";

const RECENT_KEY = "tokyo:recent-searches";
const TRENDING = ["Casque gaming", "Galaxy S26", "iPhone", "Redmi Neo", "Nintendo Switch"];

/** Accent-insensitive, lowercased. */
const norm = (t: string) =>
  t.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const tokens = (q: string) => norm(q).split(/[^a-z0-9]+/).filter(Boolean);

/** Top-level category slug of a product (first of category_path, else category).
 *  `||` not `??`: an empty-string path segment must fall through, not win. */
function topCat(p: Product): string {
  return p.category_path?.[0] || p.category || "divers";
}

/** A readable label for a top-level category slug — the taxonomy spelling when
 *  known, otherwise the slug title-cased (so a scope tab never renders blank). */
function scopeLabel(key: string): string {
  const t = taxonomyLabel(key);
  if (t) return t;
  return key
    .split(/[-_/]/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ") || "Autres";
}

/* ---------------- Search box + live dropdown ---------------- */

function SearchBox({ initialQuery }: { initialQuery: string }) {
  const router = useRouter();
  const [q, setQ] = useState(initialQuery);
  const [open, setOpen] = useState(false);
  const [recent, setRecent] = useState<string[]>([]);
  const boxRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(RECENT_KEY);
      if (raw) setRecent(JSON.parse(raw) as string[]);
    } catch {
      /* storage unavailable */
    }
  }, []);
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

  const go = (term: string) => {
    const t = term.trim();
    if (t.length < 2) return;
    try {
      const next = [t, ...recent.filter((r) => r.toLowerCase() !== t.toLowerCase())].slice(0, 6);
      localStorage.setItem(RECENT_KEY, JSON.stringify(next));
    } catch {
      /* ignore */
    }
    setOpen(false);
    inputRef.current?.blur();
    router.push(`/recherche?q=${encodeURIComponent(t)}`);
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    go(q);
  };

  const tks = tokens(q);
  const nq = norm(q.trim());
  /* Live local matches (same catalogue the header searches). */
  const matches = useMemo(() => {
    if (tks.length === 0) return [] as Product[];
    return ALL_PRODUCTS.filter((p) => {
      const hay = norm(`${p.title} ${p.brand} ${p.category}`);
      return tks.every((t) => hay.includes(t));
    }).slice(0, 40);
  }, [tks]);
  const preview = matches.slice(0, 4);

  const clearRecent = () => {
    setRecent([]);
    try {
      localStorage.removeItem(RECENT_KEY);
    } catch {
      /* ignore */
    }
  };
  const removeRecent = (t: string) => {
    const next = recent.filter((r) => r !== t);
    setRecent(next);
    try {
      localStorage.setItem(RECENT_KEY, JSON.stringify(next));
    } catch {
      /* ignore */
    }
  };

  return (
    <div ref={boxRef} className="relative z-[35] w-full">
      <form
        role="search"
        onSubmit={submit}
        className={cn(
          "flex h-16 items-center gap-2 rounded-full border-[1.5px] pl-5 pr-2 transition-[border-color,box-shadow,background] duration-200",
          open ? "border-foreground bg-background ring-4 ring-primary/15" : "border-border bg-secondary",
        )}
      >
        <SearchIcon
          aria-hidden
          className={cn("size-5 shrink-0 transition-colors", open ? "text-primary" : "text-foreground")}
          strokeWidth={2.2}
        />
        <input
          ref={inputRef}
          type="text"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          enterKeyHint="search"
          placeholder="Rechercher un produit, une marque, une référence…"
          aria-label="Rechercher"
          autoComplete="off"
          spellCheck={false}
          className="h-full min-w-0 flex-1 border-none bg-transparent text-[17px] font-semibold text-foreground outline-none placeholder:font-medium placeholder:text-muted-foreground"
        />
        {q.length > 0 && (
          <>
            <button
              type="button"
              onClick={() => {
                setQ("");
                setOpen(true);
                inputRef.current?.focus();
              }}
              aria-label="Effacer la recherche"
              className="grid size-8 shrink-0 place-items-center rounded-full bg-border text-muted-foreground transition-colors hover:bg-foreground hover:text-background"
            >
              <X aria-hidden className="size-3.5" strokeWidth={2.6} />
            </button>
            <span className="h-6 w-px shrink-0 bg-border" />
          </>
        )}
        <button
          type="submit"
          className="flex h-12 shrink-0 items-center gap-2 rounded-full bg-primary px-5 text-[15px] font-bold text-primary-foreground transition-[filter] hover:brightness-95"
        >
          Rechercher
          <ArrowRight aria-hidden className="size-4" strokeWidth={2.4} />
        </button>
      </form>

      {/* Dropdown — a plain suggestions region (not an ARIA listbox: its children
          are section groups, recent/suggestion buttons and product links, not
          role="option" items, so a listbox role would be broken semantics). */}
      <div
        role="region"
        aria-label="Suggestions de recherche"
        className={cn(
          "absolute inset-x-0 top-[calc(100%+8px)] z-10 max-h-[min(72vh,620px)] origin-top overflow-y-auto rounded-[28px] border border-border bg-background p-2 shadow-overlay transition-[opacity,transform] duration-200",
          open ? "scale-100 opacity-100" : "pointer-events-none -translate-y-2 scale-[0.985] opacity-0",
        )}
      >
        {nq === "" ? (
          /* Idle — recent + trending */
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="flex flex-col p-2">
              <div className="flex h-8 items-center justify-between px-2.5">
                <span className="text-[11px] font-extrabold uppercase tracking-[0.14em] text-muted-foreground">
                  Recherches récentes
                </span>
                {recent.length > 0 && (
                  <button
                    type="button"
                    onClick={clearRecent}
                    className="text-[12px] font-bold text-primary"
                  >
                    Tout effacer
                  </button>
                )}
              </div>
              {recent.length === 0 ? (
                <div className="flex h-11 items-center px-2.5 text-[14px] text-muted-foreground">
                  Aucune recherche récente
                </div>
              ) : (
                recent.map((t) => (
                  <div key={t} className="flex items-center rounded-[12px] hover:bg-surface-warm">
                    <button
                      type="button"
                      onClick={() => go(t)}
                      className="flex h-11 flex-1 items-center gap-3 rounded-[12px] px-2.5 text-left text-[14px] text-foreground"
                    >
                      <Clock aria-hidden className="size-4 shrink-0 text-muted-foreground/70" strokeWidth={2.2} />
                      <span className="min-w-0 flex-1 truncate">{t}</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => removeRecent(t)}
                      aria-label="Retirer"
                      className="mr-1.5 grid size-8 place-items-center rounded-full text-muted-foreground/70 hover:bg-secondary hover:text-foreground"
                    >
                      <X aria-hidden className="size-3" strokeWidth={2.4} />
                    </button>
                  </div>
                ))
              )}
            </div>
            <div className="flex flex-col rounded-[20px] bg-surface-warm p-2">
              <div className="flex h-8 items-center px-2.5">
                <span className="text-[11px] font-extrabold uppercase tracking-[0.14em] text-muted-foreground">
                  Suggestions
                </span>
              </div>
              {TRENDING.map((t, i) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => go(t)}
                  className="flex h-11 items-center gap-3 rounded-[12px] px-2.5 text-left text-[14px] font-semibold text-foreground hover:bg-background"
                >
                  <span
                    className={cn(
                      "grid size-6 shrink-0 place-items-center rounded-full text-[11px] font-extrabold",
                      i < 3 ? "bg-primary text-primary-foreground" : "bg-secondary text-foreground",
                    )}
                  >
                    {i + 1}
                  </span>
                  <span className="flex-1">{t}</span>
                  <TrendingUp aria-hidden className="size-3.5 shrink-0 text-primary" strokeWidth={2.2} />
                </button>
              ))}
            </div>
          </div>
        ) : matches.length === 0 ? (
          /* No local suggestion */
          <div className="flex items-center gap-3.5 px-4 py-5">
            <span className="grid size-10 shrink-0 place-items-center rounded-full bg-secondary text-muted-foreground">
              <SearchIcon aria-hidden className="size-[18px]" strokeWidth={2.2} />
            </span>
            <span className="text-[15px] leading-relaxed text-muted-foreground">
              Aucune suggestion locale pour «&nbsp;<strong className="text-foreground">{q}</strong>&nbsp;».
              Appuyez sur Entrée pour lancer la recherche.
            </span>
          </div>
        ) : (
          /* Typing — product preview + see-all */
          <>
            <div className="flex flex-col rounded-[20px] bg-surface-warm p-2">
              <div className="flex h-8 items-center justify-between px-2.5">
                <span className="text-[11px] font-extrabold uppercase tracking-[0.14em] text-muted-foreground">
                  Produits
                </span>
              </div>
              {preview.map((p) => {
                const oos = stockState(p) === "out_of_stock";
                return (
                  <Link
                    key={p.slug}
                    href={`/${p.slug}`}
                    onClick={() => setOpen(false)}
                    className="flex h-[72px] items-center gap-3 rounded-[14px] py-0 pl-2 pr-2.5 text-foreground hover:bg-background"
                  >
                    <span className="grid size-14 shrink-0 place-items-center overflow-hidden rounded-xl border border-border bg-background">
                      <img src={p.image} alt="" className="size-full object-contain p-1" loading="lazy" />
                    </span>
                    <span className="flex min-w-0 flex-1 flex-col gap-1">
                      <span className="line-clamp-2 text-[14px] font-semibold leading-[18px]">
                        {p.title}
                      </span>
                      <span className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
                        <span
                          className={cn("size-1.5 rounded-full", oos ? "bg-muted-foreground" : "bg-success")}
                        />
                        {oos ? "Rupture" : "En stock"}
                      </span>
                    </span>
                    <span className="shrink-0 whitespace-nowrap text-[15px] font-extrabold text-primary">
                      {fmtPrice(p.price)} <span className="text-[10px]">TND</span>
                    </span>
                  </Link>
                );
              })}
            </div>
            <button
              type="button"
              onClick={() => go(q)}
              className="mt-2 flex h-[52px] w-full items-center justify-between gap-3 rounded-[18px] bg-foreground py-0 pl-5 pr-2 text-left text-[14px] text-background transition-[filter] hover:brightness-125"
            >
              <span className="min-w-0 truncate">
                Voir tous les résultats pour «&nbsp;{q}&nbsp;»
              </span>
              <span className="grid size-9 shrink-0 place-items-center rounded-full bg-primary">
                <ArrowRight aria-hidden className="size-4 text-primary-foreground" strokeWidth={2.4} />
              </span>
            </button>
          </>
        )}
      </div>
    </div>
  );
}

/* ---------------- Scoped listing ---------------- */

/** The listing for the active scope. A separate component so it can be keyed on
 *  the scope at the call site — remounting resets its filter/sort/page state when
 *  the scope changes, instead of carrying a previous scope's filters over. */
function ScopedListing({ products }: { products: Product[] }) {
  const listing = useProductListing(products);
  return <ListingRegion listing={listing} />;
}

/* ---------------- Search view ---------------- */

export function SearchView({
  query,
  products,
  notice,
}: {
  query: string;
  products: Product[];
  /** Set for too-short / rate-limited committed searches (shown instead of the
   *  standard no-match card). */
  notice?: string;
}) {
  const [scope, setScope] = useState("all");

  /* Result-scope tabs = the matched products grouped by top-level category. */
  const scopes = useMemo(() => {
    const counts = new Map<string, number>();
    products.forEach((p) => {
      const k = topCat(p);
      counts.set(k, (counts.get(k) ?? 0) + 1);
    });
    const cats = [...counts.entries()]
      .map(([key, count]) => ({ key, label: scopeLabel(key), count }))
      .sort((a, b) => b.count - a.count);
    return [{ key: "all", label: "Tous", count: products.length }, ...cats];
  }, [products]);

  const scoped = useMemo(
    () => (scope === "all" ? products : products.filter((p) => topCat(p) === scope)),
    [products, scope],
  );

  const catCount = scopes.length - 1;
  const totalLabel =
    products.length === 0
      ? "0 produit trouvé"
      : `${products.length} produit${products.length > 1 ? "s" : ""} trouvé${products.length > 1 ? "s" : ""} dans ${catCount} catégorie${catCount > 1 ? "s" : ""}`;

  return (
    <div className="page-container flex flex-col gap-5 pt-3">
      {/* 1. Search header */}
      <section className="flex flex-col items-center gap-7 rounded-[36px] bg-background p-5 sm:p-7 lg:p-8">
        {/* Keyed on the committed query so the box re-syncs to the current search
            on same-route navigation (e.g. header "Voir tous" / a popular-search). */}
        <SearchBox key={query} initialQuery={query} />
        <div className="flex flex-col items-center gap-2 text-center">
          {query ? (
            <h1 className="text-[clamp(26px,3.2vw,44px)] font-black leading-[1.1] tracking-[-0.035em] text-balance">
              Résultats pour «&nbsp;<span className="text-primary">{query}</span>&nbsp;»
            </h1>
          ) : (
            <h1 className="text-[clamp(26px,3.2vw,44px)] font-black leading-[1.1] tracking-[-0.035em] text-balance">
              Que recherchez-vous&nbsp;?
            </h1>
          )}
          {query && <span className="text-[15px] text-muted-foreground">{totalLabel}</span>}
        </div>
        {products.length > 0 && scopes.length > 1 && (
          <div role="tablist" className="flex flex-wrap justify-center gap-2">
            {scopes.map((s) => {
              const on = scope === s.key;
              return (
                <button
                  key={s.key}
                  role="tab"
                  aria-selected={on}
                  onClick={() => setScope(s.key)}
                  className={cn(
                    "flex h-11 items-center gap-2.5 rounded-full py-0 pl-4 pr-3 text-[15px] font-bold transition-colors duration-200",
                    on ? "bg-foreground text-background" : "bg-secondary text-foreground hover:brightness-[0.97]",
                  )}
                >
                  {s.label}
                  <span
                    className={cn(
                      "grid h-[22px] min-w-[26px] place-items-center rounded-full px-2 text-[12px] font-extrabold tabular-nums",
                      on ? "bg-primary text-primary-foreground" : "bg-background text-foreground",
                    )}
                  >
                    {s.count}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </section>

      {/* 2. Listing or no-results. ScopedListing is keyed on `scope` so switching
          a scope tab remounts it — its filters/sort/page reset to a clean view of
          the new scope (SearchView itself is keyed on the query at the RSC call
          site, so a brand-new search resets the scope to "Tous"). */}
      {products.length > 0 ? (
        <ScopedListing key={scope} products={scoped} />
      ) : (
        <section className="flex flex-col items-center gap-5 rounded-[36px] bg-background px-6 py-12 text-center sm:px-10 lg:py-16">
          <span className="grid size-[72px] place-items-center rounded-full bg-primary/10 text-primary">
            <SearchIcon aria-hidden className="size-7" strokeWidth={2.2} />
          </span>
          <h2 className="text-[clamp(24px,2.6vw,36px)] font-extrabold tracking-[-0.03em] text-balance">
            {notice ? notice : <>Aucun produit ne correspond à «&nbsp;{query}&nbsp;»</>}
          </h2>
          {!notice && (
            <ul className="flex flex-col gap-1.5 text-[15px] text-graphite">
              <li>Vérifiez l&apos;orthographe des mots-clés</li>
              <li>Essayez un terme plus général, par exemple «&nbsp;casque&nbsp;» ou «&nbsp;Galaxy&nbsp;»</li>
              <li>
                Besoin d&apos;aide ?{" "}
                <Link href="/aide" className="font-bold text-foreground">
                  Contactez-nous
                </Link>
                , nous trouverons le produit pour vous
              </li>
            </ul>
          )}
          <div className="mt-2 flex flex-col items-center gap-2.5">
            <span className="text-[12px] font-extrabold uppercase tracking-[0.12em] text-muted-foreground">
              Suggestions
            </span>
            <div className="flex flex-wrap justify-center gap-2">
              {TRENDING.map((t) => (
                <Link
                  key={t}
                  href={`/recherche?q=${encodeURIComponent(t)}`}
                  className="flex h-[42px] items-center gap-2 rounded-full bg-secondary px-4 text-[14px] font-semibold text-foreground transition-colors hover:bg-foreground hover:text-background"
                >
                  <TrendingUp aria-hidden className="size-3.5 text-primary" strokeWidth={2.2} />
                  {t}
                </Link>
              ))}
            </div>
          </div>
        </section>
      )}

      {/* 3. Service band */}
      <ServiceBand />
    </div>
  );
}
