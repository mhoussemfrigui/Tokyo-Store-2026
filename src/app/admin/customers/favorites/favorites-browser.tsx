"use client";

import Link from "next/link";
import { useRef, useState, useTransition } from "react";
import { Loader2, SlidersHorizontal, X, ChevronLeft, ChevronRight, Heart, AlertTriangle } from "lucide-react";

import { searchFavoritesAction, favoritesStatsAction } from "@/lib/actions/wishlist";
import { SelectField } from "@/components/ui/select-field";
import { formatMoney } from "@/lib/price";
import { ExportFieldPicker } from "@/components/admin/export-field-picker";
import { FAVORITES_EXPORT_FIELDS } from "@/lib/export/favorites-fields";
import { AdminToolbar, AdminSearch, SegmentedFilter } from "@/components/admin/_components/filter-bar";
import {
  EMPTY_FAVORITES_FILTER,
  FAV_PUBLISHED_OPTIONS,
  favoritesFilterToParams,
  isEmptyFavoritesFilter,
  type FavoritesFilter,
  type FavoritesStats,
  type FavoritedProductRow,
} from "@/lib/wishlist/favorites-filter-shared";

const PAGE_SIZE = 30;

/**
 * The Clients → Favoris DEMAND board: a filterable statistics header (the stock cards are
 * quick-filters), a filter panel (search / stock / category / published), the keyset-paged
 * ranked product list (favorites count desc), and a FILTERED CSV export. Stats + list +
 * export run off the same server-side FavoritesFilter. The « En rupture » card surfaces
 * products customers want but can't buy — the restock priority signal.
 */
export function FavoritesBrowser({
  initialItems,
  initialNextCursor,
  initialStats,
  categories,
  canExport,
}: {
  initialItems: FavoritedProductRow[];
  initialNextCursor: string | null;
  initialStats: FavoritesStats;
  categories: Array<{ id: string; name: string }>;
  canExport: boolean;
}) {
  const [filter, setFilter] = useState<FavoritesFilter>(EMPTY_FAVORITES_FILTER);
  const [rows, setRows] = useState(initialItems);
  const [stats, setStats] = useState(initialStats);
  const [panelOpen, setPanelOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  const cursors = useRef<Array<string | undefined>>([undefined, initialNextCursor ?? undefined]);
  const [page, setPage] = useState(0);
  const [hasNext, setHasNext] = useState(initialNextCursor != null);
  const reqSeq = useRef(0);

  const load = (targetPage: number, f: FavoritesFilter, withStats: boolean) => {
    const mine = ++reqSeq.current;
    startTransition(async () => {
      const cursor = cursors.current[targetPage];
      const [list, s] = await Promise.all([
        searchFavoritesAction({ filter: f, cursor }),
        withStats ? favoritesStatsAction(f) : Promise.resolve(null),
      ]);
      if (mine !== reqSeq.current) return; // superseded
      setRows(list.items);
      cursors.current[targetPage + 1] = list.nextCursor ?? undefined;
      setHasNext(list.nextCursor != null);
      setPage(targetPage);
      if (s) setStats(s);
    });
  };

  const apply = (next: FavoritesFilter) => {
    setFilter(next);
    cursors.current = [undefined];
    load(0, next, true);
  };
  const patch = (p: Partial<FavoritesFilter>) => apply({ ...filter, ...p });

  const active = !isEmptyFavoritesFilter(filter);
  const filterKey = JSON.stringify(filter);

  const categoryOptions = [{ value: "", label: "Toutes" }, ...categories.map((c) => ({ value: c.id, label: c.name }))];

  return (
    <div className="space-y-4">
      {/* ── Statistics header — reflects the active filter ── */}
      <div className="rounded-[28px] border border-border bg-card p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-[13px] font-black text-foreground">
            {active ? "Produits favoris (filtrés)" : "Produits favoris"}
            <span className="ml-2 rounded-full bg-foreground px-2 py-0.5 text-[11px] font-bold text-background tabular-nums">
              {stats.totalProducts.toLocaleString("fr-FR")} produit{stats.totalProducts === 1 ? "" : "s"}
            </span>
          </h2>
          <div className="flex items-center gap-3">
            <span className="text-[11px] text-muted-foreground tabular-nums">
              {stats.totalSaves.toLocaleString("fr-FR")} favoris · {stats.recentSaves30.toLocaleString("fr-FR")} ces 30j ({stats.recentSaves7.toLocaleString("fr-FR")} ces 7j)
            </span>
            {pending && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
          </div>
        </div>
      </div>

      {/* ── Search + controls row ── */}
      <AdminToolbar>
        <AdminSearch
          key={`${filterKey}:q`}
          defaultValue={filter.search}
          onKeyDown={(e) => {
            if (e.key === "Enter") patch({ search: (e.target as HTMLInputElement).value.trim() });
          }}
          placeholder="Rechercher un produit…"
          className="min-w-0 max-w-md flex-1"
        />
        <SegmentedFilter
          ariaLabel="Stock"
          value={filter.stock}
          onChange={(v) => patch({ stock: v as FavoritesFilter["stock"] })}
          options={[
            { value: "any", label: "Tous" },
            { value: "in", label: "En stock", count: stats.inStock },
            { value: "out", label: "En rupture", count: stats.outOfStock },
          ]}
        />
        <button
          type="button"
          onClick={() => setPanelOpen((v) => !v)}
          className={`inline-flex h-11 items-center gap-1.5 rounded-full border-[1.5px] px-4 text-[13px] font-bold transition ${
            active ? "border-primary bg-[var(--accent)] text-primary" : "border-input bg-card text-foreground hover:bg-surface"
          }`}
        >
          <SlidersHorizontal className="h-4 w-4" /> Filtres{active ? " · actifs" : ""}
        </button>
        {active && (
          <button
            type="button"
            onClick={() => apply(EMPTY_FAVORITES_FILTER)}
            className="inline-flex h-11 items-center gap-1.5 rounded-full border-[1.5px] border-input bg-card px-3 text-[13px] font-bold text-muted-foreground hover:bg-surface"
          >
            <X className="h-3.5 w-3.5" /> Réinitialiser
          </button>
        )}
        <div className="ml-auto">
          {canExport && (
            <ExportFieldPicker
              baseUrl="/api/admin/customers/favorites/export"
              fields={FAVORITES_EXPORT_FIELDS}
              extraParams={favoritesFilterToParams(filter)}
              label="Exporter (filtré)"
            />
          )}
        </div>
      </AdminToolbar>

      {/* ── Filter panel (controls disabled while a page/stats fetch is in flight) ── */}
      {panelOpen && (
        <div className="grid gap-4 rounded-[22px] border border-border bg-card p-5 sm:grid-cols-2">
          <Field label="Catégorie">
            <SelectField ariaLabel="Catégorie" size="sm" searchable disabled={pending} options={categoryOptions} value={filter.categoryId} onChange={(v) => patch({ categoryId: v })} />
          </Field>
          <Field label="Publication">
            <SelectField ariaLabel="Publication" size="sm" disabled={pending} options={FAV_PUBLISHED_OPTIONS.map((o) => ({ value: o.value, label: o.label }))} value={filter.published} onChange={(v) => patch({ published: v as FavoritesFilter["published"] })} />
          </Field>
        </div>
      )}

      {/* ── Ranked list ── */}
      {rows.length === 0 ? (
        <div className="rounded-[22px] border border-dashed border-border bg-card p-12 text-center text-[14px] text-muted-foreground">
          {active ? "Aucun produit favori ne correspond à ces filtres." : "Aucun favori enregistré pour le moment."}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-[22px] border border-border bg-card">
          <table className="w-full text-sm">
            <thead className="border-b border-border bg-[#fbf9f8] text-left text-[12px] font-bold uppercase tracking-[0.06em] text-[#8a857f]">
              <tr>
                <th className="px-4 py-3">#</th>
                <th className="px-4 py-3">Produit</th>
                <th className="px-4 py-3">Catégorie</th>
                <th className="px-4 py-3 text-right">Favoris</th>
                <th className="px-4 py-3 text-right">30j</th>
                <th className="px-4 py-3">Stock</th>
                <th className="px-4 py-3 text-right">Prix</th>
                <th className="px-4 py-3">Dernier ajout</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((r, i) => (
                <tr key={r.productId} className="hover:bg-[#fffbfb]">
                  <td className="px-4 py-3 align-middle text-[14px] font-semibold text-muted-foreground tabular-nums">{page * PAGE_SIZE + i + 1}</td>
                  <td className="px-4 py-3 align-middle">
                    {r.slug ? (
                      <Link href={`/${r.slug}`} className="font-medium text-foreground hover:text-primary hover:underline">
                        {r.name ?? r.slug}
                      </Link>
                    ) : (
                      <span className="font-medium text-foreground">{r.name ?? "Produit supprimé"}</span>
                    )}
                    {!r.isPublished && <span className="ml-2 rounded-full bg-[#f6f2ed] px-1.5 py-0.5 text-[9px] font-bold uppercase text-[#5b5d62]">Dépublié</span>}
                  </td>
                  <td className="px-4 py-3 align-middle text-[14px] text-muted-foreground">
                    {r.categorySlug ? (
                      <Link href={`/${r.categorySlug}`} className="hover:text-primary hover:underline">{r.categoryName}</Link>
                    ) : (
                      r.categoryName ?? "—"
                    )}
                  </td>
                  <td className="px-4 py-3 align-middle text-right">
                    <span className="inline-flex items-center gap-1.5 rounded-full bg-[var(--accent)] px-2.5 py-1 text-[12px] font-bold text-primary">
                      <Heart className="h-3.5 w-3.5" /> {r.count.toLocaleString("fr-FR")}
                    </span>
                  </td>
                  <td className="px-4 py-3 align-middle text-right text-[14px] tabular-nums text-muted-foreground">{r.recent30.toLocaleString("fr-FR")}</td>
                  <td className="px-4 py-3 align-middle text-[14px]">
                    {r.inStock ? (
                      <span className="inline-flex items-center gap-1.5 rounded-full border border-[#cdebd6] bg-[#eaf7ee] px-2.5 py-1 text-[11px] font-bold text-[#15803d]">
                        En stock{r.stockQty != null ? ` · ${r.stockQty}` : ""}
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1.5 rounded-full border border-[#f3e3bd] bg-[#fff4e0] px-2.5 py-1 text-[11px] font-bold text-[#b45309]">
                        <AlertTriangle className="h-3 w-3" /> En rupture
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 align-middle text-right text-[14px] tabular-nums">{formatMoney(r.priceCents)}</td>
                  <td className="px-4 py-3 align-middle text-[14px] text-muted-foreground">
                    {r.lastAddedAt ? new Date(r.lastAddedAt).toLocaleDateString("fr-FR") : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ── Pagination (keyset Prev/Next; total is in the header). ── */}
      {(page > 0 || hasNext) && (
        <div className="flex items-center justify-between gap-3">
          <p className="text-[12px] text-muted-foreground">
            {(rows.length > 0 ? page * PAGE_SIZE + 1 : 0).toLocaleString("fr-FR")}–{(page * PAGE_SIZE + rows.length).toLocaleString("fr-FR")} sur {stats.totalProducts.toLocaleString("fr-FR")}
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => load(page - 1, filter, false)}
              disabled={pending || page === 0}
              className="inline-flex h-9 items-center gap-1 rounded-full border-[1.5px] border-input bg-card px-3 text-[12px] font-bold text-foreground hover:bg-surface disabled:opacity-40"
            >
              <ChevronLeft className="h-4 w-4" /> Précédent
            </button>
            <span className="text-[12px] font-semibold tabular-nums text-muted-foreground">Page {page + 1}</span>
            <button
              type="button"
              onClick={() => load(page + 1, filter, false)}
              disabled={pending || !hasNext}
              className="inline-flex h-9 items-center gap-1 rounded-full border-[1.5px] border-input bg-card px-3 text-[12px] font-bold text-foreground hover:bg-surface disabled:opacity-40"
            >
              Suivant <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <span className="mb-1 block text-[13px] font-bold text-foreground">{label}</span>
      {children}
    </div>
  );
}
