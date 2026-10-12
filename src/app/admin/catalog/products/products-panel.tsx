"use client";

import Image from "next/image";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState, useTransition } from "react";
import {
  Archive,
  ArchiveRestore,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Copy,
  ExternalLink,
  Eye,
  FolderTree,
  Loader2,
  MoreHorizontal,
  Pencil,
  Tag,
  Trash2,
  X,
} from "lucide-react";

import { ConfirmDeleteModal } from "@/components/admin/confirm-delete-modal";
import { IconButton } from "@/components/admin/icon-button";
import { SelectField } from "@/components/ui/select-field";
import { AdminSearch, SegmentedFilter } from "@/components/admin/_components/filter-bar";
import { bulkAssignAttributesAction } from "@/lib/actions/attribute";
import type { AttributeKind } from "@/modules/catalog/attribute/schema";
import {
  deleteProductAction,
  duplicateProductAction,
  setProductArchivedAction,
} from "@/lib/actions/catalog";
import { formatMoneyWithCurrency } from "@/lib/price";
import { isEffectivelyOutOfStock } from "@/lib/inventory/stock-state";
import type { ActionState } from "@/lib/actions/types";

type Product = {
  id: string;
  slug: string;
  name: string;
  priceCents: number;
  currency: string;
  inStock: boolean;
  /** Tracked product-level quantity (NULL = untracked) — with `inStock`, drives
   *  the SHARED effective-availability pill (a qty-0 line left « Disponible »
   *  reads Indisponible, as on the storefront and the Stock page). Optional so an
   *  older caller that doesn't pass it keeps the flag-only behaviour. */
  stockQty?: number | null;
  isPublished: boolean;
  primaryImageUrl: string | null;
  createdAt: string;
  /** Soft-deleted (the « Supprimé » filter): store-zone date label, else null. */
  deletedAtLabel: string | null;
};

/** Outcome of a row quick action (Dupliquer / Publier / Dépublier). */
type RowNotice = { ok: boolean; text: string };

type Filters = { q: string; categoryId: string; status: string };
type Pagination = { page: number; pageSize: number; total: number };

/** Recursive category node — same {id, name, children} shape the page maps
 *  the full `CategoryTreeNode` into; the filter drill-down walks it any depth. */
type CategoryNode = { id: string; name: string; children: CategoryNode[] };

export function ProductsPanel({
  products,
  categories,
  attributes,
  filters,
  pagination,
  canCreate,
  canUpdate,
  canDelete,
  canBulkAttributes,
}: {
  products: Product[];
  categories: CategoryNode[];
  attributes: {
    id: string;
    slug: string;
    name: string;
    kind: AttributeKind;
    values: { id: string; slug: string; label: string }[];
  }[];
  filters: Filters;
  pagination: Pagination;
  /** Per-action grants (resolved server-side). A products:view-only operator
   *  gets a read-only list; the server actions re-check regardless. */
  canCreate: boolean;
  canUpdate: boolean;
  canDelete: boolean;
  /** Bulk « Assigner attributs » writes attribute assignments → attributes:update
   *  (an independent RBAC module), not products:update. */
  canBulkAttributes: boolean;
}) {
  const [toDelete, setToDelete] = useState<Product | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkDialogOpen, setBulkDialogOpen] = useState(false);
  const [rowNotice, setRowNotice] = useState<RowNotice | null>(null);
  const router = useRouter();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();

  // Only LIVE rows are selectable — a soft-deleted row (« Supprimé » view) takes
  // no bulk action.
  const productIds = useMemo(
    () => new Set(products.filter((p) => !p.deletedAtLabel).map((p) => p.id)),
    [products],
  );
  const visibleSelected = useMemo(
    () => Array.from(selectedIds).filter((id) => productIds.has(id)),
    [selectedIds, productIds],
  );
  const allVisibleSelected =
    productIds.size > 0 && visibleSelected.length === productIds.size;

  // Selection is scoped to the CURRENT page only. Whenever the page, filters
  // or page-size change (i.e. the URL query string changes), clear it and close
  // any open bulk dialog — so the bulk bar can never silently act on a stale or
  // off-page set. Cross-page persistence is intentionally NOT attempted.
  const searchKey = searchParams.toString();
  useEffect(() => {
    setSelectedIds(new Set());
    setBulkDialogOpen(false);
    setRowNotice(null);
  }, [searchKey]);

  const toggleOne = (id: string) =>
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const toggleAllVisible = () =>
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (allVisibleSelected) {
        for (const id of productIds) next.delete(id);
      } else {
        for (const id of productIds) next.add(id);
      }
      return next;
    });

  const totalPages = Math.max(1, Math.ceil(pagination.total / pagination.pageSize));

  function updateFilters(patch: Partial<Filters> & { page?: number; pageSize?: number }) {
    const next = new URLSearchParams(searchParams.toString());
    if (patch.q !== undefined) {
      if (patch.q) next.set("q", patch.q);
      else next.delete("q");
    }
    if (patch.categoryId !== undefined) {
      if (patch.categoryId) next.set("categoryId", patch.categoryId);
      else next.delete("categoryId");
    }
    if (patch.status !== undefined) {
      if (patch.status) next.set("status", patch.status);
      else next.delete("status");
    }
    if (patch.pageSize !== undefined) next.set("pageSize", String(patch.pageSize));
    // Any filter OR page-size change resets to page 1 unless the caller
    // explicitly bumps the page (Précédent/Suivant/window buttons).
    if (patch.page !== undefined) next.set("page", String(patch.page));
    else if (
      patch.q !== undefined ||
      patch.categoryId !== undefined ||
      patch.status !== undefined ||
      patch.pageSize !== undefined
    ) {
      next.delete("page");
    }
    startTransition(() => router.push(`?${next.toString()}`));
  }

  function gotoPage(p: number) {
    updateFilters({ page: Math.max(1, Math.min(totalPages, p)) });
  }

  return (
    <div className="space-y-6">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const fd = new FormData(e.currentTarget);
          updateFilters({
            q: String(fd.get("q") ?? "").trim(),
            categoryId: String(fd.get("categoryId") ?? ""),
            status: String(fd.get("status") ?? ""),
          });
        }}
        className="flex flex-wrap items-end gap-3 rounded-[22px] border border-border bg-card p-4"
      >
        <div className="flex-1 min-w-[200px]">
          <span className="text-[13px] font-bold text-foreground">
            Recherche
          </span>
          {/* Keyed to the APPLIED term so « Réinitialiser » (which clears ?q but
              doesn't remount this client component) re-mounts the uncontrolled
              input and the box stops showing the stale term. Typing doesn't change
              filters.q, so in-progress input is preserved. */}
          <AdminSearch
            key={filters.q}
            name="q"
            defaultValue={filters.q}
            placeholder="Nom ou SKU…"
            className="mt-1 w-full"
          />
        </div>
        <CategoryFilter
          categories={categories}
          value={filters.categoryId}
          onChange={(categoryId) => updateFilters({ categoryId })}
        />
        <div className="min-w-[160px]">
          <span className="block text-[13px] font-bold text-foreground">Statut</span>
          {/* Mirror the status into the form so the "Filtrer" submit keeps it
              (the submit reads FormData); the pill applies immediately on click. */}
          <input type="hidden" name="status" value={filters.status} />
          <SegmentedFilter<"all" | "draft" | "published" | "archived">
            ariaLabel="Statut"
            className="mt-1"
            value={(filters.status || "all") as "all" | "draft" | "published" | "archived"}
            onChange={(v) => updateFilters({ status: v === "all" ? "" : v })}
            options={[
              { value: "all", label: "Tous" },
              { value: "draft", label: "Brouillon" },
              { value: "published", label: "Publié" },
              // status="archived" maps to soft-deleted rows (deleted_at IS NOT
              // NULL) — a DIFFERENT mechanism from the row "Dépublier" action
              // (is_published=false, which shows under "Brouillon"). Labelled
              // "Supprimé" so the two don't read as the same bucket.
              { value: "archived", label: "Supprimé" },
            ]}
          />
        </div>
        <div className="flex gap-2">
          <button
            type="submit"
            disabled={isPending}
            className="inline-flex h-11 items-center rounded-full bg-primary px-5 text-[14px] font-extrabold text-primary-foreground hover:bg-[#b8042a] disabled:opacity-60"
          >
            Filtrer
          </button>
          {(filters.q || filters.categoryId || filters.status) && (
            <button
              type="button"
              onClick={() => updateFilters({ q: "", categoryId: "", status: "" })}
              className="inline-flex h-11 items-center rounded-full border-[1.5px] border-input bg-card px-4 text-[14px] font-bold text-foreground hover:bg-surface"
            >
              Réinitialiser
            </button>
          )}
        </div>
      </form>

      {visibleSelected.length >= 2 && attributes.length > 0 && canBulkAttributes && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-[16px] border border-primary/30 bg-[var(--accent)] px-4 py-3">
          <p className="text-sm font-bold">
            {visibleSelected.length} produit{visibleSelected.length > 1 ? "s" : ""} sélectionné
            {visibleSelected.length > 1 ? "s" : ""}{" "}
            <span className="font-normal text-muted-foreground">sur cette page</span>
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setBulkDialogOpen(true)}
              className="inline-flex h-9 items-center gap-1 rounded-full bg-primary px-3 text-xs font-extrabold text-primary-foreground hover:bg-[#b8042a]"
            >
              <Tag className="h-3 w-3" /> Assigner attributs
            </button>
            <button
              type="button"
              onClick={() => setSelectedIds(new Set())}
              className="text-xs font-bold text-muted-foreground hover:text-foreground"
            >
              Désélectionner
            </button>
          </div>
        </div>
      )}

      {/* Outcome of a row quick action — a failed Dupliquer / Publier / Dépublier
          (slug exhaustion, a variable product without variants, …) is no longer
          swallowed, and a success carries its caveats (e.g. the copy's stock
          reset to 0). */}
      {rowNotice && (
        <div
          role={rowNotice.ok ? "status" : "alert"}
          className={`flex items-start justify-between gap-3 rounded-[16px] border px-4 py-3 text-sm ${
            rowNotice.ok
              ? "border-primary/30 bg-[var(--accent)] text-foreground"
              : "border-destructive/40 bg-destructive/5 text-destructive"
          }`}
        >
          <p>{rowNotice.text}</p>
          <button
            type="button"
            onClick={() => setRowNotice(null)}
            aria-label="Fermer"
            className="grid h-6 w-6 shrink-0 place-items-center rounded-[10px] text-muted-foreground hover:bg-secondary"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {products.length === 0 ? (
        <div className="rounded-[22px] border border-dashed border-border bg-card p-12 text-center text-[14px] text-muted-foreground">
          Aucun produit ne correspond aux filtres.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-[22px] border border-border bg-card">
          <table className="w-full text-sm">
            <thead className="bg-[#fbf9f8] text-left text-[12px] font-bold uppercase tracking-[0.06em] text-[#8a857f]">
              <tr>
                <th className="px-5 py-3 w-10">
                  <input
                    type="checkbox"
                    checked={allVisibleSelected}
                    onChange={toggleAllVisible}
                    disabled={productIds.size === 0}
                    aria-label="Tout sélectionner sur cette page"
                    className="h-4 w-4 accent-[var(--primary)] disabled:opacity-40"
                  />
                </th>
                <th className="px-5 py-3">Produit</th>
                <th className="px-5 py-3">Prix</th>
                <th className="px-5 py-3">Stock</th>
                <th className="px-5 py-3">Statut</th>
                <th className="px-5 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {products.map((p) => (
                <ProductRow
                  key={p.id}
                  product={p}
                  selected={selectedIds.has(p.id)}
                  onToggleSelected={() => toggleOne(p.id)}
                  onAskDelete={() => setToDelete(p)}
                  onActionResult={setRowNotice}
                  canCreate={canCreate}
                  canUpdate={canUpdate}
                  canDelete={canDelete}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {bulkDialogOpen && (
        <BulkAttributesDialog
          productIds={visibleSelected}
          attributes={attributes}
          onClose={() => setBulkDialogOpen(false)}
          onSuccess={() => {
            setBulkDialogOpen(false);
            setSelectedIds(new Set());
            router.refresh();
          }}
        />
      )}

      {pagination.total > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 px-1 text-sm">
          <div className="flex flex-wrap items-center gap-3">
            <p className="text-[13px] text-muted-foreground">
              {pagination.total} résultat{pagination.total > 1 ? "s" : ""} · page{" "}
              {pagination.page} / {totalPages}
            </p>
            <div className="flex items-center gap-1.5">
              <SelectField
                ariaLabel="Produits par page"
                size="sm"
                className="w-[88px]"
                value={String(pagination.pageSize)}
                onChange={(v) => updateFilters({ pageSize: Number(v) })}
                options={[
                  { value: "10", label: "10" },
                  { value: "25", label: "25" },
                  { value: "50", label: "50" },
                  { value: "100", label: "100" },
                ]}
              />
              <span className="text-xs text-muted-foreground">par page</span>
            </div>
          </div>
          <div className="inline-flex items-center gap-1">
            <button
              type="button"
              onClick={() => gotoPage(pagination.page - 1)}
              disabled={pagination.page <= 1 || isPending}
              className="inline-flex h-9 items-center gap-1 rounded-full border-[1.5px] border-input bg-card px-3 text-xs font-bold disabled:opacity-40"
            >
              <ChevronLeft className="h-3.5 w-3.5" /> Précédent
            </button>
            <PageButtons
              page={pagination.page}
              totalPages={totalPages}
              onSelect={gotoPage}
              disabled={isPending}
            />
            <button
              type="button"
              onClick={() => gotoPage(pagination.page + 1)}
              disabled={pagination.page >= totalPages || isPending}
              className="inline-flex h-9 items-center gap-1 rounded-full border-[1.5px] border-input bg-card px-3 text-xs font-bold disabled:opacity-40"
            >
              Suivant <ChevronRight className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      )}

      {toDelete && (
        <ConfirmDeleteModal
          title="Supprimer ce produit ?"
          description="Le produit est masqué de la boutique. L'historique des commandes liées reste intact."
          preview={
            <div className="flex items-center gap-3 rounded-[16px] border border-border bg-[#fbf9f8] p-2">
              <span className="grid h-12 w-12 shrink-0 place-items-center overflow-hidden rounded-[12px] bg-surface">
                {toDelete.primaryImageUrl ? (
                  <Image
                    src={toDelete.primaryImageUrl}
                    alt=""
                    width={48}
                    height={48}
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <span className="text-xs text-muted-foreground">—</span>
                )}
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] font-bold">{toDelete.name}</p>
                <p className="text-[12px] text-muted-foreground">/{toDelete.slug}</p>
              </div>
            </div>
          }
          onCancel={() => setToDelete(null)}
          onConfirm={async () => {
            const res = await deleteProductAction(toDelete.id);
            return res.ok ? null : (res.message ?? "Erreur");
          }}
        />
      )}
    </div>
  );
}

/** Flat index of a category id → its node + breadcrumb names (root→node). */
function indexCategories(
  nodes: CategoryNode[],
): Map<string, { node: CategoryNode; pathNames: string[] }> {
  const map = new Map<string, { node: CategoryNode; pathNames: string[] }>();
  const walk = (list: CategoryNode[], ancestors: string[]) => {
    for (const n of list) {
      const pathNames = [...ancestors, n.name];
      map.set(n.id, { node: n, pathNames });
      if (n.children.length) walk(n.children, pathNames);
    }
  };
  walk(nodes, []);
  return map;
}

/**
 * Hierarchical category filter — a trigger button that opens a drill-down
 * tree popover modelled on the storefront mega-menu
 * (src/components/site-header.tsx): start at the roots, click a node WITH
 * children to drill in (breadcrumb climbs back up), and click a node's name
 * to CHOOSE it as the filter. Choosing sets `?categoryId` via the parent's
 * `updateFilters` (page 1 reset), and the list rolls up that category's
 * descendants (server-side recursive CTE). Any depth supported.
 *
 * A hidden `<input name="categoryId">` mirrors the current value so the
 * sibling "Filtrer" button (which reads FormData) preserves the selection.
 */
function CategoryFilter({
  categories,
  value,
  onChange,
}: {
  categories: CategoryNode[];
  value: string;
  onChange: (categoryId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  // Drill position inside the popover: ancestor ids (empty = roots).
  const [path, setPath] = useState<string[]>([]);
  const flat = useMemo(() => indexCategories(categories), [categories]);

  const selectedLabel = value
    ? flat.get(value)?.pathNames.join(" › ") ?? "Catégorie"
    : "Toutes les catégories";

  const currentLevel: CategoryNode[] =
    path.length === 0
      ? categories
      : flat.get(path[path.length - 1])?.node.children ?? [];

  const choose = (id: string) => {
    onChange(id);
    setOpen(false);
    setPath([]);
  };

  return (
    <div className="min-w-[200px]">
      <span className="text-[13px] font-bold text-foreground">
        Catégorie
      </span>
      {/* Mirror the value into the form so the "Filtrer" submit keeps it. */}
      <input type="hidden" name="categoryId" value={value} />
      <div className="relative mt-1">
        <button
          type="button"
          onClick={() => {
            setOpen((v) => !v);
            // Open the popover already drilled to the selected branch.
            if (!open && value) {
              const names = flat.get(value)?.pathNames.slice(0, -1) ?? [];
              const ids: string[] = [];
              let level = categories;
              for (const name of names) {
                const hit = level.find((n) => n.name === name);
                if (!hit) break;
                ids.push(hit.id);
                level = hit.children;
              }
              setPath(ids);
            } else if (!open) {
              setPath([]);
            }
          }}
          className="flex h-11 w-full items-center justify-between gap-2 rounded-[14px] border-[1.5px] border-input bg-[#fbf9f8] px-3 text-[15px] transition hover:bg-white"
        >
          <span className="flex min-w-0 items-center gap-2">
            <FolderTree className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span className={`truncate ${value ? "font-medium text-foreground" : "text-muted-foreground"}`}>
              {selectedLabel}
            </span>
          </span>
          <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
        </button>

        {open && (
          <>
            {/* Click-outside backdrop — mirrors RowActionsMenu's pattern. */}
            <button
              type="button"
              aria-label="Fermer"
              onClick={() => setOpen(false)}
              className="fixed inset-0 z-10 cursor-default bg-transparent"
            />
            <div className="absolute left-0 top-12 z-20 max-h-[60vh] w-80 max-w-[90vw] overflow-y-auto rounded-[16px] border border-border bg-card p-2 shadow-soft">
              {/* "Toutes" — clears the filter. */}
              <button
                type="button"
                onClick={() => choose("")}
                className="flex w-full items-center justify-between gap-2 rounded-[10px] px-3 py-2 text-left text-[14px] font-semibold hover:bg-surface"
              >
                Toutes les catégories
                {!value && <Check className="h-4 w-4 text-primary" />}
              </button>

              {/* Breadcrumb. */}
              <div className="mt-1 flex flex-wrap items-center gap-1 border-t border-border px-1 pt-2 text-xs">
                <button
                  type="button"
                  onClick={() => setPath([])}
                  className={`inline-flex h-6 items-center rounded-full px-2 font-bold transition ${
                    path.length === 0
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:bg-surface hover:text-foreground"
                  }`}
                >
                  Racine
                </button>
                {path.map((id, idx) => (
                  <span key={id} className="flex items-center gap-1">
                    <ChevronRight className="h-3 w-3 text-muted-foreground" />
                    <button
                      type="button"
                      onClick={() => setPath((p) => p.slice(0, idx + 1))}
                      className={`inline-flex h-6 items-center rounded-full px-2 font-bold transition ${
                        idx === path.length - 1
                          ? "bg-primary text-primary-foreground"
                          : "text-muted-foreground hover:bg-surface hover:text-foreground"
                      }`}
                    >
                      {flat.get(id)?.node.name ?? "—"}
                    </button>
                  </span>
                ))}
              </div>

              {/* Current level — name chooses the filter; chevron drills in. */}
              <div className="mt-1.5 space-y-0.5">
                {currentLevel.map((node) => {
                  const hasChildren = node.children.length > 0;
                  const isSelected = value === node.id;
                  return (
                    <div
                      key={node.id}
                      className={`flex items-center gap-1 rounded-[12px] pr-1 transition ${
                        isSelected ? "bg-[var(--accent)]" : "hover:bg-surface"
                      }`}
                    >
                      <button
                        type="button"
                        onClick={() => choose(node.id)}
                        className="flex min-w-0 flex-1 items-center justify-between gap-2 px-3 py-2 text-left text-sm"
                      >
                        <span className={`truncate ${isSelected ? "font-semibold text-primary" : "font-medium"}`}>
                          {node.name}
                        </span>
                        {isSelected && <Check className="h-4 w-4 shrink-0 text-primary" />}
                      </button>
                      {hasChildren && (
                        <button
                          type="button"
                          onClick={() => setPath((p) => [...p, node.id])}
                          aria-label={`Ouvrir les sous-catégories de ${node.name}`}
                          className="inline-flex h-7 shrink-0 items-center gap-0.5 rounded-full px-2 text-[11px] font-bold text-muted-foreground transition hover:bg-secondary hover:text-foreground"
                        >
                          {node.children.length}
                          <ChevronRight className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>
                  );
                })}
                {currentLevel.length === 0 && (
                  <p className="px-3 py-4 text-center text-[12px] text-muted-foreground">
                    Aucune sous-catégorie.
                  </p>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function PageButtons({
  page,
  totalPages,
  onSelect,
  disabled,
}: {
  page: number;
  totalPages: number;
  onSelect: (p: number) => void;
  disabled?: boolean;
}) {
  // Show up to 5 pages around current — keeps the bar compact on small lists
  // and avoids drawing a fragile sliding-window calc for huge ones.
  const window = 2;
  const start = Math.max(1, page - window);
  const end = Math.min(totalPages, page + window);
  const pages: number[] = [];
  for (let i = start; i <= end; i++) pages.push(i);
  return (
    <>
      {pages.map((p) => (
        <button
          key={p}
          type="button"
          onClick={() => onSelect(p)}
          disabled={disabled || p === page}
          className={`inline-flex h-9 min-w-9 items-center justify-center rounded-full px-3 text-xs font-bold transition ${
            p === page
              ? "bg-primary text-primary-foreground"
              : "border-[1.5px] border-input bg-card hover:bg-surface"
          }`}
        >
          {p}
        </button>
      ))}
    </>
  );
}

/**
 * Bulk attribute assignment dialog. Renders one block per attribute, each
 * with its value checkboxes. Submitting merges the picked values into every
 * selected product's existing assignments (no destructive replace).
 */
function BulkAttributesDialog({
  productIds,
  attributes,
  onClose,
  onSuccess,
}: {
  productIds: string[];
  attributes: {
    id: string;
    slug: string;
    name: string;
    kind: AttributeKind;
    values: { id: string; slug: string; label: string }[];
  }[];
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const toggle = (id: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const submit = () => {
    setError(null);
    startTransition(async () => {
      // Wrap in try/catch like RowActionsMenu.run: bulkAssignAttributesAction
      // requires attributes:update, and requirePermission throws notFound() on
      // denial — an unhandled rejection here would replace the page with the 404
      // boundary instead of showing this inline error (same for any thrown error).
      try {
        const res = await bulkAssignAttributesAction({
          productIds,
          attributeValueIds: Array.from(picked),
        });
        if (res.ok) onSuccess();
        else setError(res.message);
      } catch {
        setError("L'action a échoué — réessayez.");
      }
    });
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-foreground/40 p-4 backdrop-blur-sm">
      <div className="w-full max-w-2xl rounded-[28px] border border-border bg-card p-5 shadow-soft">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-[18px] font-black text-foreground">Assigner des attributs</h3>
            <p className="mt-1 text-[13px] text-muted-foreground">
              Les valeurs cochées seront ajoutées aux {productIds.length} produit
              {productIds.length > 1 ? "s" : ""} sélectionné
              {productIds.length > 1 ? "s" : ""}. Les attributs existants ne seront pas
              écrasés.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Fermer"
            className="grid h-9 w-9 place-items-center rounded-[11px] bg-surface text-muted-foreground hover:bg-secondary hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
        <div className="mt-4 max-h-[60vh] space-y-3 overflow-y-auto">
          {attributes.map((attr) => (
            <div
              key={attr.id}
              className="rounded-[16px] border border-border bg-[#fbf9f8] p-3"
            >
              <p className="text-[13px] font-bold text-foreground">
                {attr.name}
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                {attr.values.map((v) => {
                  const checked = picked.has(v.id);
                  return (
                    <label
                      key={v.id}
                      className={`inline-flex cursor-pointer items-center gap-2 rounded-full border-[1.5px] px-3 py-1.5 text-xs font-bold transition ${
                        checked
                          ? "border-primary bg-primary text-primary-foreground"
                          : "border-input bg-card text-foreground hover:bg-surface"
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggle(v.id)}
                        className="hidden"
                      />
                      {v.label}
                    </label>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
        {error && <p className="mt-3 text-[13px] text-destructive">{error}</p>}
        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-9 items-center rounded-full border-[1.5px] border-input bg-card px-4 text-xs font-bold text-foreground hover:bg-surface"
          >
            Annuler
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={pending || picked.size === 0}
            className="inline-flex h-9 items-center gap-2 rounded-full bg-primary px-4 text-xs font-extrabold text-primary-foreground hover:bg-[#b8042a] disabled:opacity-60"
          >
            {pending && <Loader2 className="h-3 w-3 animate-spin" />}
            Appliquer ({picked.size})
          </button>
        </div>
      </div>
    </div>
  );
}

function ProductRow({
  product,
  selected,
  onToggleSelected,
  onAskDelete,
  onActionResult,
  canCreate,
  canUpdate,
  canDelete,
}: {
  product: Product;
  selected: boolean;
  onToggleSelected: () => void;
  onAskDelete: () => void;
  onActionResult: (notice: RowNotice) => void;
  /** products:create — gates Dupliquer (via the quick-actions menu). */
  canCreate: boolean;
  /** products:update — gates Modifier + Publier/Dépublier. */
  canUpdate: boolean;
  /** products:delete — gates Supprimer. */
  canDelete: boolean;
}) {
  // A soft-deleted row (« Supprimé » view) has no working action: the editor
  // 404s it and duplicate / publish / delete all resolve `not_found`. Show when
  // it was deleted instead of dead controls (no restore workflow yet).
  const deleted = product.deletedAtLabel !== null;
  return (
    <tr className="transition hover:bg-[#fffbfb]">
      <td className="px-5 py-3">
        {!deleted && (
          <input
            type="checkbox"
            checked={selected}
            onChange={onToggleSelected}
            aria-label={`Sélectionner ${product.name}`}
            className="h-4 w-4 accent-[var(--primary)]"
          />
        )}
      </td>
      <td className="px-5 py-3">
        <div className="flex items-center gap-3">
          <div className="relative h-12 w-12 shrink-0 overflow-hidden rounded-[12px] bg-surface">
            {product.primaryImageUrl ? (
              <Image
                src={product.primaryImageUrl}
                alt={product.name}
                fill
                sizes="48px"
                className="object-cover"
              />
            ) : null}
          </div>
          <div className="min-w-0">
            <p className="truncate text-[14px] font-bold text-foreground">{product.name}</p>
            <p className="truncate text-[12px] text-muted-foreground">/{product.slug}</p>
          </div>
        </div>
      </td>
      <td className="px-5 py-3 text-[14px] font-bold">
        {formatMoneyWithCurrency(product.priceCents, product.currency)}
      </td>
      <td className="px-5 py-3">
        {!isEffectivelyOutOfStock(product.inStock, product.stockQty ?? null) ? (
          <span className="inline-flex items-center rounded-full bg-[#eaf7ee] px-2.5 py-1 text-[11px] font-bold text-[#15803d]">
            En stock
          </span>
        ) : (
          <span className="inline-flex items-center rounded-full bg-[#f6f2ed] px-2.5 py-1 text-[11px] font-bold text-[#5b5d62]">
            Indisponible
          </span>
        )}
      </td>
      <td className="px-5 py-3">
        {deleted ? (
          <span className="inline-flex items-center whitespace-nowrap rounded-full bg-[#fdecef] px-2.5 py-1 text-[11px] font-bold text-[#d40530]">
            Supprimé le {product.deletedAtLabel}
          </span>
        ) : product.isPublished ? (
          <span className="inline-flex items-center rounded-full bg-[#eaf7ee] px-2.5 py-1 text-[11px] font-bold text-[#15803d]">
            Publié
          </span>
        ) : (
          <span className="inline-flex items-center rounded-full bg-[#fff4e0] px-2.5 py-1 text-[11px] font-bold text-[#b45309]">
            Brouillon
          </span>
        )}
      </td>
      <td className="px-5 py-3 text-right">
        {deleted ? (
          <span className="text-[12px] text-muted-foreground">—</span>
        ) : (
          <div className="inline-flex items-center gap-2">
            {/* Direct storefront link — published opens the live page; a draft
                opens the admin-only preview (the storefront 404s drafts for
                non-admins, but renderProductView previews them for admins). */}
            <Link
              href={`/${product.slug}`}
              target="_blank"
              rel="noopener noreferrer"
              className="grid h-11 w-11 place-items-center rounded-[14px] bg-surface text-muted-foreground transition hover:bg-secondary hover:text-foreground"
              aria-label={product.isPublished ? "Voir sur la boutique" : "Aperçu (brouillon)"}
              title={product.isPublished ? "Voir sur la boutique" : "Aperçu (brouillon)"}
            >
              {product.isPublished ? (
                <ExternalLink className="h-4 w-4" />
              ) : (
                <Eye className="h-4 w-4 text-[#b45309]" />
              )}
            </Link>
            {canUpdate && (
              <Link
                href={`/admin/catalog/products/${product.id}`}
                className="grid h-11 w-11 place-items-center rounded-[14px] bg-surface text-muted-foreground transition hover:bg-secondary hover:text-foreground"
                aria-label="Modifier"
              >
                <Pencil className="h-4 w-4" />
              </Link>
            )}
            {(canCreate || canUpdate) && (
              <RowActionsMenu
                product={product}
                onResult={onActionResult}
                canCreate={canCreate}
                canUpdate={canUpdate}
              />
            )}
            {canDelete && (
              <IconButton
                icon={<Trash2 className="h-4 w-4" />}
                aria-label="Supprimer"
                tone="danger"
                size="md"
                onClick={onAskDelete}
              />
            )}
          </div>
        )}
      </td>
    </tr>
  );
}

/**
 * Per-row dropdown for less-frequent actions: duplicate + archive toggle. (The
 * storefront link is now a direct icon button in the row.) Open/close is
 * self-contained — click anywhere outside closes via a backdrop listener. Every
 * outcome is reported through `onResult` (the panel's notice banner): a failure
 * used to be swallowed (`if (res.ok) refresh()` with no else).
 */
function RowActionsMenu({
  product,
  onResult,
  canCreate,
  canUpdate,
}: {
  product: Product;
  onResult: (notice: RowNotice) => void;
  /** products:create — gates Dupliquer. */
  canCreate: boolean;
  /** products:update — gates Publier/Dépublier. */
  canUpdate: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  const run = (action: () => Promise<ActionState>) => {
    setOpen(false);
    startTransition(async () => {
      try {
        const res = await action();
        onResult({
          ok: res.ok,
          text: res.message ?? (res.ok ? "Action effectuée." : "L'action a échoué."),
        });
        if (res.ok) router.refresh();
      } catch {
        onResult({ ok: false, text: "L'action a échoué — réessayez." });
      }
    });
  };

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={pending}
        className="grid h-11 w-11 place-items-center rounded-[14px] bg-surface text-muted-foreground transition hover:bg-secondary hover:text-foreground disabled:opacity-50"
        aria-label="Actions rapides"
        title="Actions rapides"
      >
        {pending ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <MoreHorizontal className="h-4 w-4" />
        )}
      </button>
      {open && (
        <>
          {/* Click-outside backdrop. */}
          <button
            type="button"
            aria-label="Fermer le menu"
            onClick={() => setOpen(false)}
            className="fixed inset-0 z-10 cursor-default bg-transparent"
          />
          <div className="absolute right-0 top-12 z-20 w-56 overflow-hidden rounded-[16px] border border-border bg-card shadow-soft">
            {canCreate && (
              <button
                type="button"
                onClick={() => run(() => duplicateProductAction(product.id))}
                className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-[13px] font-semibold hover:bg-surface"
              >
                <Copy className="h-3.5 w-3.5 text-muted-foreground" /> Dupliquer
              </button>
            )}
            {canUpdate &&
              (product.isPublished ? (
                <button
                  type="button"
                  onClick={() => run(() => setProductArchivedAction(product.id, true))}
                  className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-[13px] font-semibold hover:bg-surface"
                >
                  <Archive className="h-3.5 w-3.5 text-muted-foreground" /> Dépublier
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => run(() => setProductArchivedAction(product.id, false))}
                  className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-[13px] font-semibold hover:bg-surface"
                >
                  <ArchiveRestore className="h-3.5 w-3.5 text-muted-foreground" /> Publier
                </button>
              ))}
          </div>
        </>
      )}
    </div>
  );
}
