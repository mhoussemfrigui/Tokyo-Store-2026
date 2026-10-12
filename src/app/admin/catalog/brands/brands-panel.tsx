"use client";

import Image from "next/image";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState, useTransition } from "react";
import {
  ArrowUpDown,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  ExternalLink,
  Eye,
  EyeOff,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";

import { ConfirmDeleteModal } from "@/components/admin/confirm-delete-modal";
import { IconButton } from "@/components/admin/icon-button";
import { AdminCallout, AdminNote, AdminSearch } from "@/components/admin/_components/filter-bar";
import {
  deleteBrandAction,
  reorderBrandsAction,
  setBrandActiveAction,
} from "@/lib/actions/catalog";

type Brand = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  isActive: boolean;
  logoUrl: string | null;
};

/** Slim row for the reorder mode (the full live set, ordered). */
type ReorderBrand = { id: string; name: string; logoUrl: string | null };

type Pagination = { page: number; pageSize: number; total: number };

export function BrandsPanel({
  brands,
  query = "",
  pagination,
  canCreate,
  canUpdate,
  canDelete,
  reorderBrands,
}: {
  brands: Brand[];
  query?: string;
  pagination: Pagination;
  /** Brand CRUD gates — hide controls whose server action would 404 for a view-only role. */
  canCreate: boolean;
  canUpdate: boolean;
  canDelete: boolean;
  /** The FULL live brand set (ordered) for the "Réorganiser" mode. */
  reorderBrands: ReorderBrand[];
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [toDelete, setToDelete] = useState<Brand | null>(null);
  const [searchInput, setSearchInput] = useState(query);

  // Inline activate-toggle: one pending indicator + a shared error line.
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [togglePending, startToggle] = useTransition();
  const [actionError, setActionError] = useState<string | null>(null);

  // "Réorganiser" mode — the paginated/searchable list can't do cross-page
  // reordering, so a dedicated mode loads the FULL ordered set with up/down arrows.
  const [reordering, setReordering] = useState(false);

  const totalPages = Math.max(1, Math.ceil(pagination.total / pagination.pageSize));

  const navigate = (patch: { q?: string; page?: number }) => {
    const next = new URLSearchParams(searchParams.toString());
    if (patch.q !== undefined) {
      if (patch.q) next.set("q", patch.q);
      else next.delete("q");
      next.delete("page");
    }
    if (patch.page !== undefined) {
      const clamped = Math.max(1, Math.min(totalPages, patch.page));
      if (clamped > 1) next.set("page", String(clamped));
      else next.delete("page");
    }
    const qs = next.toString();
    router.push(qs ? `/admin/catalog/brands?${qs}` : "/admin/catalog/brands");
  };

  const submitSearch = (e: React.FormEvent) => {
    e.preventDefault();
    navigate({ q: searchInput.trim() });
  };

  const handleToggleActive = (brand: Brand) => {
    setActionError(null);
    setTogglingId(brand.id);
    startToggle(async () => {
      const res = await setBrandActiveAction(brand.id, !brand.isActive);
      if (!res.ok) setActionError(res.message ?? "Action impossible.");
      setTogglingId(null);
      router.refresh();
    });
  };

  const from = pagination.total === 0 ? 0 : (pagination.page - 1) * pagination.pageSize + 1;
  const to = Math.min(pagination.page * pagination.pageSize, pagination.total);

  return (
    <div className="space-y-6">
      <AdminNote className="max-w-3xl">
        Marques affichées sur les fiches produit et le filtre catalogue.
      </AdminNote>

      {actionError && <AdminCallout tone="danger">{actionError}</AdminCallout>}

      {/* ─── List / Réorganiser ─────────────────────────────────────────── */}
      <div className="space-y-6">
        {reordering ? (
          <ReorderView
            initial={reorderBrands}
            onDone={() => {
              setReordering(false);
              router.refresh();
            }}
            onError={setActionError}
          />
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-[22px] border border-border bg-card px-5 py-4">
              <div className="flex min-w-0 max-w-sm flex-1 flex-col gap-2">
                <form onSubmit={submitSearch} className="w-full">
                  <AdminSearch
                    value={searchInput}
                    onChange={(e) => setSearchInput(e.target.value)}
                    placeholder="Rechercher une marque…"
                    aria-label="Rechercher une marque"
                    className="w-full"
                  />
                </form>
                <AdminNote>
                  {pagination.total === 0 ? "Aucune marque" : `${from}–${to} sur ${pagination.total}`}
                </AdminNote>
              </div>
              <div className="flex items-center gap-2">
                {canUpdate && reorderBrands.length > 1 && (
                  <button
                    type="button"
                    onClick={() => {
                      setActionError(null);
                      setReordering(true);
                    }}
                    className="inline-flex h-11 items-center gap-2 rounded-full border-[1.5px] border-input bg-card px-4 text-[14px] font-bold text-foreground hover:bg-surface"
                    title="Réorganiser l'ordre d'affichage des marques"
                  >
                    <ArrowUpDown className="h-4 w-4" /> Réorganiser
                  </button>
                )}
                {canCreate && (
                  <Link
                    href="/admin/catalog/brands/new"
                    className="inline-flex h-11 items-center gap-2 rounded-full bg-primary px-5 text-[14px] font-extrabold text-primary-foreground hover:bg-[#b8042a]"
                  >
                    <Plus className="h-4 w-4" /> Nouvelle marque
                  </Link>
                )}
              </div>
            </div>

            {brands.length === 0 ? (
              <EmptyState
                message={
                  query
                    ? `Aucune marque ne correspond à « ${query} ».`
                    : "Aucune marque pour le moment."
                }
              />
            ) : (
              <ul className="divide-y divide-border rounded-[22px] border border-border bg-card">
                {brands.map((b) => (
                  <BrandRow
                    key={b.id}
                    brand={b}
                    canUpdate={canUpdate}
                    canDelete={canDelete}
                    onToggleActive={handleToggleActive}
                    togglePending={togglePending && togglingId === b.id}
                    onAskDelete={() => setToDelete(b)}
                  />
                ))}
              </ul>
            )}

            {totalPages > 1 && (
              <Pager page={pagination.page} totalPages={totalPages} onSelect={(p) => navigate({ page: p })} />
            )}
          </>
        )}
      </div>

      {toDelete && (
        <ConfirmDeleteModal
          title="Supprimer cette marque ?"
          description="Les produits associés ne seront plus rattachés à cette marque."
          preview={
            <div className="flex items-center gap-3 rounded-[16px] border border-border bg-[#fbf9f8] p-2">
              <span className="grid h-12 w-12 shrink-0 place-items-center overflow-hidden rounded-[12px] bg-surface">
                {toDelete.logoUrl ? (
                  <Image
                    src={toDelete.logoUrl}
                    alt=""
                    width={48}
                    height={48}
                    className="h-full w-full object-contain"
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
            const res = await deleteBrandAction(toDelete.id);
            return res.ok ? null : (res.message ?? "Erreur");
          }}
        />
      )}
    </div>
  );
}

/** The full-list up/down reorder view (flat display_order). */
function ReorderView({
  initial,
  onDone,
  onError,
}: {
  initial: ReorderBrand[];
  onDone: () => void;
  onError: (msg: string | null) => void;
}) {
  const [order, setOrder] = useState<ReorderBrand[]>(initial);
  const [pending, startTransition] = useTransition();

  const move = (index: number, dir: -1 | 1) => {
    const target = index + dir;
    if (target < 0 || target >= order.length) return;
    const next = [...order];
    [next[index], next[target]] = [next[target], next[index]];
    setOrder(next);
    onError(null);
    startTransition(async () => {
      const res = await reorderBrandsAction(next.map((b) => b.id));
      if (!res.ok) onError(res.message ?? "Réordonnancement impossible.");
    });
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-[22px] border border-border bg-card px-5 py-4">
        <AdminNote>
          Réorganisez l&apos;ordre d&apos;affichage des marques (barre de navigation).
        </AdminNote>
        <button
          type="button"
          onClick={onDone}
          className="inline-flex h-11 items-center gap-2 rounded-full bg-primary px-5 text-[14px] font-extrabold text-primary-foreground hover:bg-[#b8042a]"
        >
          Terminé
        </button>
      </div>
      <ul className="divide-y divide-border rounded-[22px] border border-border bg-card">
        {order.map((b, i) => (
          <li key={b.id} className="flex items-center justify-between gap-3 p-3">
            <div className="flex min-w-0 items-center gap-3">
              <span className="grid h-9 w-9 shrink-0 place-items-center overflow-hidden rounded-[12px] bg-surface">
                {b.logoUrl ? (
                  <Image src={b.logoUrl} alt="" width={36} height={36} className="h-full w-full object-contain" />
                ) : (
                  <span className="text-[10px] text-muted-foreground">—</span>
                )}
              </span>
              <p className="truncate text-[14px] font-bold">{b.name}</p>
            </div>
            <div className="flex items-center">
              <button
                type="button"
                onClick={() => move(i, -1)}
                disabled={i === 0 || pending}
                aria-label="Monter"
                title="Monter"
                className="grid h-8 w-8 place-items-center rounded-l-full text-muted-foreground transition hover:bg-surface hover:text-foreground disabled:opacity-30"
              >
                <ChevronUp className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={() => move(i, 1)}
                disabled={i === order.length - 1 || pending}
                aria-label="Descendre"
                title="Descendre"
                className="grid h-8 w-8 place-items-center rounded-r-full text-muted-foreground transition hover:bg-surface hover:text-foreground disabled:opacity-30"
              >
                <ChevronDown className="h-4 w-4" />
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function BrandRow({
  brand,
  canUpdate,
  canDelete,
  onToggleActive,
  togglePending,
  onAskDelete,
}: {
  brand: Brand;
  canUpdate: boolean;
  canDelete: boolean;
  onToggleActive: (brand: Brand) => void;
  togglePending: boolean;
  onAskDelete: () => void;
}) {
  return (
    <li className="flex items-center justify-between gap-3 p-4">
      <div className="flex items-center gap-3">
        <div className="relative h-10 w-10 shrink-0 overflow-hidden rounded-[12px] bg-surface">
          {brand.logoUrl ? (
            <Image src={brand.logoUrl} alt={brand.name} fill sizes="40px" className="object-contain" />
          ) : null}
        </div>
        <div>
          <p className="text-[14px] font-bold text-foreground">{brand.name}</p>
          <p className="text-[12px] text-muted-foreground">
            /{brand.slug}
            {!brand.isActive && " · désactivée"}
          </p>
        </div>
      </div>
      <div className="inline-flex items-center gap-1">
        {canUpdate && (
          <button
            type="button"
            onClick={() => onToggleActive(brand)}
            disabled={togglePending}
            aria-pressed={brand.isActive}
            aria-label={brand.isActive ? "Désactiver" : "Activer"}
            title={
              brand.isActive
                ? "Visible sur la boutique — cliquer pour désactiver"
                : "Masquée — cliquer pour activer"
            }
            className={`grid h-11 w-11 place-items-center rounded-[14px] bg-surface transition hover:bg-secondary disabled:opacity-40 ${
              brand.isActive ? "text-primary" : "text-muted-foreground"
            }`}
          >
            {brand.isActive ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
          </button>
        )}
        {/* Storefront link only for ACTIVE brands — an inactive brand 404s at /<slug>. */}
        {brand.isActive && (
          <Link
            href={`/${brand.slug}`}
            target="_blank"
            rel="noopener noreferrer"
            className="grid h-11 w-11 place-items-center rounded-[14px] bg-surface text-muted-foreground hover:bg-secondary hover:text-foreground"
            aria-label="Voir sur la boutique"
            title="Voir sur la boutique"
          >
            <ExternalLink className="h-4 w-4" />
          </Link>
        )}
        {canUpdate && (
          <Link
            href={`/admin/catalog/brands/${brand.id}`}
            className="grid h-11 w-11 place-items-center rounded-[14px] bg-surface text-muted-foreground hover:bg-secondary hover:text-foreground"
            aria-label="Modifier"
          >
            <Pencil className="h-4 w-4" />
          </Link>
        )}
        {canDelete && (
          <IconButton
            icon={<Trash2 className="h-4 w-4" />}
            aria-label="Supprimer"
            tone="danger"
            onClick={onAskDelete}
          />
        )}
      </div>
    </li>
  );
}

/**
 * Build a compact page list with first/last anchors + ellipsis gaps, e.g.
 * [1, "…", 4, 5, 6, "…", 20]. Shows every page when there are ≤ 7.
 */
function buildPageList(current: number, total: number): (number | "ellipsis")[] {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const anchors = new Set([1, total, current, current - 1, current + 1]);
  const sorted = [...anchors].filter((p) => p >= 1 && p <= total).sort((a, b) => a - b);
  const out: (number | "ellipsis")[] = [];
  let prev = 0;
  for (const p of sorted) {
    if (p - prev > 1) out.push("ellipsis");
    out.push(p);
    prev = p;
  }
  return out;
}

function Pager({
  page,
  totalPages,
  onSelect,
}: {
  page: number;
  totalPages: number;
  onSelect: (p: number) => void;
}) {
  const items = buildPageList(page, totalPages);
  const navBtn =
    "inline-flex h-9 w-9 items-center justify-center rounded-[11px] border-[1.5px] border-input bg-card text-muted-foreground transition hover:bg-surface disabled:cursor-not-allowed disabled:opacity-40";
  return (
    <nav className="flex items-center justify-center gap-1.5" aria-label="Pagination">
      <button
        type="button"
        onClick={() => onSelect(1)}
        disabled={page <= 1}
        className={navBtn}
        aria-label="Première page"
      >
        <ChevronLeft className="h-4 w-4 -mr-2" />
        <ChevronLeft className="h-4 w-4" />
      </button>
      <button
        type="button"
        onClick={() => onSelect(page - 1)}
        disabled={page <= 1}
        className={navBtn}
        aria-label="Page précédente"
      >
        <ChevronLeft className="h-4 w-4" />
      </button>
      {items.map((it, i) =>
        it === "ellipsis" ? (
          <span key={`e${i}`} className="px-1 text-xs text-muted-foreground" aria-hidden>
            …
          </span>
        ) : (
          <button
            key={it}
            type="button"
            onClick={() => onSelect(it)}
            disabled={it === page}
            aria-current={it === page ? "page" : undefined}
            className={`inline-flex h-9 min-w-9 items-center justify-center rounded-full px-3 text-xs font-bold transition ${
              it === page ? "bg-primary text-primary-foreground" : "border-[1.5px] border-input bg-card hover:bg-surface"
            }`}
          >
            {it}
          </button>
        ),
      )}
      <button
        type="button"
        onClick={() => onSelect(page + 1)}
        disabled={page >= totalPages}
        className={navBtn}
        aria-label="Page suivante"
      >
        <ChevronRight className="h-4 w-4" />
      </button>
      <button
        type="button"
        onClick={() => onSelect(totalPages)}
        disabled={page >= totalPages}
        className={navBtn}
        aria-label="Dernière page"
      >
        <ChevronRight className="h-4 w-4 -mr-2" />
        <ChevronRight className="h-4 w-4" />
      </button>
    </nav>
  );
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="rounded-[22px] border border-dashed border-border bg-card p-12 text-center text-[14px] text-muted-foreground">
      {message}
    </div>
  );
}
