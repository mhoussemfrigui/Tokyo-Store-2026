"use client";

import { useActionState, useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Loader2,
  Plus,
  Save,
  Search,
  ShieldCheck,
  Trash2,
  UserPen,
  X,
} from "lucide-react";

import { ToggleField } from "@/components/admin/_components/setting-fields";
import { AdminNote, SegmentedFilter } from "@/components/admin/_components/filter-bar";
import { ConfirmDeleteModal } from "@/components/admin/confirm-delete-modal";
import { SelectField } from "@/components/ui/select-field";
import { StarRating } from "@/components/ui/star-rating";
import {
  createManualReviewAction,
  deleteReviewAction,
  deleteReviewsBySourceAction,
  saveReviewSettingsAction,
  setReviewStatusAction,
} from "@/lib/actions/reviews";
import { searchProductsForPickerAction, type RelatedProductOption } from "@/lib/actions/related-products";
import { SubTabBar } from "@/components/admin/_components/form-tabs";
import { type ActionState } from "@/lib/actions/types";
import { REVIEW_STATUS_LABELS, REVIEW_STATUS_COLORS } from "@/modules/catalog/review/status";
import {
  SOURCE_FILTERS,
  STATUS_FILTERS as FILTERS,
  type SourceFilter,
  type StatusFilter as Filter,
} from "@/modules/catalog/review/filters";
import type { ReviewConfig, ReviewSource, ReviewStatus } from "@/modules/catalog/review";

type AdminReview = {
  id: string;
  productName: string;
  productSlug: string | null;
  /** `deleted` / `draft` = the product is gone from the storefront (no link). */
  productState: "live" | "draft" | "deleted";
  authorName: string;
  rating: number;
  title: string;
  body: string;
  status: ReviewStatus;
  source: ReviewSource;
  verifiedPurchase: boolean;
  createdAt: string;
};

// FILTERS / SOURCE_FILTERS (the status/source vocabularies) are single-sourced
// in the review module (filters.ts) and shared with the server page so the
// chips + querystring can't drift from the ?status/?source parsing. The display
// labels below are a filter-UI concern and stay local.
const FILTER_LABEL: Record<Filter, string> = {
  pending: "En attente",
  approved: "Publiés",
  rejected: "Rejetés",
  all: "Tous",
};

const SOURCE_LABEL: Record<ReviewSource, string> = { customer: "Client", manual: "Manuel", ai: "IA" };
const SOURCE_COLOR: Record<ReviewSource, string> = {
  customer: "bg-[#f6f2ed] text-[#5b5d62]",
  manual: "bg-[#eef2ff] text-[#3730a3]",
  ai: "bg-[#fff4e0] text-[#b45309]",
};

const REVIEW_TABS = [
  { id: "avis", label: "Avis" }, // moderation list + manual create
  { id: "generation", label: "Nettoyage" }, // bulk cleanup of fake (manual / legacy AI) reviews
  { id: "reglages", label: "Réglages" }, // policy / enabled / moderation
] as const;
type ReviewTab = (typeof REVIEW_TABS)[number]["id"];

const ALL_STATUSES: ReviewStatus[] = ["pending", "approved", "rejected"];
const ALL_SOURCES: ReviewSource[] = ["customer", "manual", "ai"];

/** Per-action RBAC for the moderation controls (server-enforced too). */
export type ReviewPerm = {
  moderate: boolean;
  create: boolean;
  delete: boolean;
  updateSettings: boolean;
};

export function ReviewsModerationPanel({
  reviews,
  activeStatus,
  activeSource,
  activeQuery,
  page,
  pageSize,
  total,
  matrix,
  perm,
  config,
}: {
  reviews: AdminReview[];
  activeStatus: Filter;
  activeSource: SourceFilter;
  /** Product-name filter (?q=), "" = none. */
  activeQuery: string;
  /** 1-based page of the moderation list (?page=). */
  page: number;
  pageSize: number;
  /** Rows matching the status/source/product filters (all pages). */
  total: number;
  /** Full status × source count matrix (all reviews) — folded into facet badges. */
  matrix: Record<ReviewStatus, Record<ReviewSource, number>>;
  perm: ReviewPerm;
  config: ReviewConfig;
}) {
  // Facet-scoped badge totals from the matrix: a status chip reflects the active
  // SOURCE filter (and a source chip the active STATUS), so each chip's number is
  // exactly what selecting it lists. The product-name search narrows the list +
  // `total`, not these facet counts.
  const statusChip = (s: ReviewStatus): number =>
    activeSource === "all"
      ? ALL_SOURCES.reduce((n, src) => n + matrix[s][src], 0)
      : matrix[s][activeSource];
  const sourceChip = (src: ReviewSource): number =>
    activeStatus === "all"
      ? ALL_STATUSES.reduce((n, st) => n + matrix[st][src], 0)
      : matrix[activeStatus][src];
  // Global per-source totals (all statuses) for the fake-cleanup card.
  const globalSourceCounts: Record<ReviewSource, number> = {
    customer: ALL_STATUSES.reduce((n, st) => n + matrix[st].customer, 0),
    manual: ALL_STATUSES.reduce((n, st) => n + matrix[st].manual, 0),
    ai: ALL_STATUSES.reduce((n, st) => n + matrix[st].ai, 0),
  };
  const router = useRouter();
  const [navPending, startNav] = useTransition();
  const [tab, setTab] = useState<ReviewTab>("avis");
  const [creating, setCreating] = useState(false);

  // Filtering + paging are server-side (see page.tsx) — push the chosen
  // status/source/product filter and page into the URL and let the page
  // re-query. `pending`/`all`/page 1 are the defaults so they stay out of the
  // querystring; any filter change goes back to page 1.
  const applyFilters = (next: { status?: Filter; source?: SourceFilter; q?: string; page?: number }) => {
    const status = next.status ?? activeStatus;
    const source = next.source ?? activeSource;
    const q = (next.q ?? activeQuery).trim();
    const nextPage = next.page ?? 1;
    const params = new URLSearchParams();
    if (status !== "pending") params.set("status", status);
    if (source !== "all") params.set("source", source);
    if (q) params.set("q", q);
    if (nextPage > 1) params.set("page", String(nextPage));
    const qs = params.toString();
    startNav(() => router.replace(qs ? `/admin/catalog/reviews?${qs}` : "/admin/catalog/reviews", { scroll: false }));
  };

  // The server already applied the filters + paging; `reviews` IS the view.
  const visible = reviews;
  // Tab badge = the GLOBAL pending backlog (all sources), independent of filters.
  const pendingCount = ALL_SOURCES.reduce((n, src) => n + matrix.pending[src], 0);
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const firstShown = total === 0 ? 0 : (page - 1) * pageSize + 1;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-[22px] border border-border bg-card px-5 py-4">
        <AdminNote className="max-w-3xl">
          Modérez les avis clients, générez des avis et pilotez la politique d&apos;avis.
        </AdminNote>
        {/* « Créer un avis » sits ABOVE the sub-tabs (a section-level action), not
            inside the moderation list. */}
        {perm.create && (
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="inline-flex h-11 shrink-0 items-center gap-2 rounded-full bg-primary px-5 text-[14px] font-extrabold text-primary-foreground hover:bg-[#b8042a]"
          >
            <Plus className="h-4 w-4" /> Créer un avis
          </button>
        )}
      </div>

      {/* Shared segmented tab strip (pending-count badge on Avis), hosted in a
          white nav card so the strip isn't lost on the page canvas. */}
      <SubTabBar
        tabs={REVIEW_TABS.map((t) =>
          t.id === "avis" && pendingCount > 0 ? { ...t, badge: pendingCount } : { ...t },
        )}
        activeTab={tab}
        onSelect={setTab}
      />

      {/* ── Tab: Avis (moderation + manual create). All three tab panels stay MOUNTED
          and toggle with `hidden` so unsaved Génération/Réglages edits survive a tab
          switch (matches every sibling catalog panel). ── */}
      <div hidden={tab !== "avis"} className="space-y-6">
          {/* Status filter */}
          <SegmentedFilter
            ariaLabel="Filtrer par statut"
            className={navPending ? "pointer-events-none opacity-60" : undefined}
            value={activeStatus}
            onChange={(f) => applyFilters({ status: f })}
            options={FILTERS.map((f) => ({
              value: f,
              label: FILTER_LABEL[f],
              count: f === "all" ? undefined : statusChip(f),
            }))}
          />

          {/* Source filter */}
          <div className={`flex flex-wrap items-center gap-2 ${navPending ? "opacity-60" : ""}`}>
            <span className="text-[11px] font-bold uppercase tracking-wide text-muted-foreground">
              Origine
            </span>
            <SegmentedFilter
              ariaLabel="Filtrer par origine"
              className={navPending ? "pointer-events-none" : undefined}
              value={activeSource}
              onChange={(s) => applyFilters({ source: s })}
              options={SOURCE_FILTERS.map((s) => ({
                value: s,
                label: s === "all" ? "Toutes" : SOURCE_LABEL[s],
                count: s === "all" ? undefined : sourceChip(s),
              }))}
            />
          </div>

          {/* Product-name filter */}
          <form
            key={activeQuery}
            className={`flex flex-wrap items-center gap-2 ${navPending ? "opacity-60" : ""}`}
            onSubmit={(e) => {
              e.preventDefault();
              applyFilters({ q: String(new FormData(e.currentTarget).get("q") ?? "") });
            }}
          >
            <div className="relative min-w-0 flex-1 sm:max-w-sm">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <input
                name="q"
                defaultValue={activeQuery}
                maxLength={100}
                placeholder="Filtrer par produit…"
                aria-label="Filtrer par nom de produit"
                className="h-11 w-full rounded-[14px] border-[1.5px] border-input bg-[#fbf9f8] pl-10 pr-3 text-[15px] focus:border-foreground focus:bg-white focus:outline-none"
              />
            </div>
            <button
              type="submit"
              disabled={navPending}
              className="inline-flex h-11 items-center rounded-full border-[1.5px] border-input bg-card px-4 text-[14px] font-bold text-foreground hover:bg-surface disabled:opacity-60"
            >
              Filtrer
            </button>
            {activeQuery && (
              <button
                type="button"
                disabled={navPending}
                onClick={() => applyFilters({ q: "" })}
                className="inline-flex h-11 items-center gap-1.5 rounded-full px-3 text-[14px] font-bold text-muted-foreground hover:bg-surface disabled:opacity-60"
              >
                <X className="h-3.5 w-3.5" /> Effacer
              </button>
            )}
          </form>

          {visible.length === 0 ? (
            <div className="rounded-[22px] border border-dashed border-border bg-card p-12 text-center text-[14px] text-muted-foreground">
              Aucun avis dans cette sélection.
            </div>
          ) : (
            <>
              <p className="text-[13px] text-muted-foreground">
                {visible.length} affiché{visible.length > 1 ? "s" : ""} sur {total}
                {pageCount > 1
                  ? ` (avis ${firstShown}–${firstShown + visible.length - 1}, page ${page}/${pageCount})`
                  : ""}
              </p>
              <ul className="space-y-3">
                {visible.map((r) => (
                  <ReviewRow key={r.id} review={r} perm={perm} />
                ))}
              </ul>
            </>
          )}

          {pageCount > 1 && (
            <div className={`flex items-center justify-center gap-2 ${navPending ? "opacity-60" : ""}`}>
              <button
                type="button"
                disabled={navPending || page <= 1}
                onClick={() => applyFilters({ page: page - 1 })}
                className="inline-flex h-9 items-center gap-1 rounded-full border-[1.5px] border-input bg-card px-3 text-xs font-bold hover:bg-surface disabled:opacity-40"
              >
                <ChevronLeft className="h-3.5 w-3.5" /> Précédent
              </button>
              <span className="text-xs tabular-nums text-muted-foreground">
                {page} / {pageCount}
              </span>
              <button
                type="button"
                disabled={navPending || page >= pageCount}
                onClick={() => applyFilters({ page: page + 1 })}
                className="inline-flex h-9 items-center gap-1 rounded-full border-[1.5px] border-input bg-card px-3 text-xs font-bold hover:bg-surface disabled:opacity-40"
              >
                Suivant <ChevronRight className="h-3.5 w-3.5" />
              </button>
            </div>
          )}
        </div>

      {/* ── Tab: Nettoyage (bulk-delete fake / legacy reviews by source). ── */}
      <div hidden={tab !== "generation"} className="space-y-6">
          <FakesCard sourceCounts={globalSourceCounts} canDelete={perm.delete} />
        </div>

      {/* ── Tab: Réglages (policy) ── */}
      <div hidden={tab !== "reglages"} className="space-y-6">
        <ReviewSettingsCard config={config} canSave={perm.updateSettings} />
      </div>

      {creating && <ManualReviewModal config={config} onClose={() => setCreating(false)} />}
    </div>
  );
}

function ReviewSettingsCard({ config, canSave }: { config: ReviewConfig; canSave: boolean }) {
  const [state, formAction, pending] = useActionState<ActionState | null, FormData>(
    saveReviewSettingsAction,
    null,
  );
  return (
    <form action={formAction} className="space-y-4 rounded-[28px] border border-border bg-card p-5">
      <h2 className="text-[18px] font-black text-foreground">Réglages des avis</h2>
      <ToggleField
        name="reviews.enabled"
        label="Avis activés"
        description="Affiche la section avis et autorise les nouveaux avis."
        defaultChecked={config.enabled}
      />
      <SelectField
        name="reviews.policy"
        label="Qui peut publier un avis"
        defaultValue={config.policy}
        options={[
          { value: "all", label: "Tout utilisateur connecté" },
          { value: "buyers_only", label: "Acheteurs vérifiés uniquement" },
        ]}
      />
      <ToggleField
        name="reviews.require_approval"
        label="Modération avant publication"
        description="Les nouveaux avis restent « en attente » jusqu'à votre validation."
        defaultChecked={config.requireApproval}
      />
      <SelectField
        name="reviews.rating_source"
        label="Note publique (étoiles) & données structurées"
        defaultValue={config.ratingSource}
        options={[
          { value: "customers", label: "Avis clients uniquement (recommandé)" },
          { value: "all", label: "Tous les avis approuvés (clients + IA + manuels)" },
        ]}
        helper="Détermine quels avis alimentent la note en étoiles affichée, les données structurées (Google) et les flux marchands (Google Merchant / ACP). « Avis clients uniquement » exclut les avis IA et manuels de la note publique — ils restent visibles sur la fiche mais n'influencent plus les étoiles indexées (recommandé pour la conformité Google & FTC). Changer cette option recalcule immédiatement la note de tous les produits."
      />
      {state && !state.ok && <p className="text-[13px] text-destructive">{state.message}</p>}
      {state?.ok && <p className="text-[13px] text-[#15803d]">{state.message}</p>}
      {!canSave && (
        <AdminNote>Vous avez un accès en lecture seule aux réglages des avis.</AdminNote>
      )}
      <button
        type="submit"
        disabled={pending || !canSave}
        className="inline-flex h-11 items-center gap-2 rounded-full bg-primary px-5 text-[14px] font-extrabold text-primary-foreground hover:bg-[#b8042a] disabled:opacity-60"
      >
        {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
        Enregistrer
      </button>
    </form>
  );
}

/** Bulk-cleanup of fake reviews by origin (manual / ai). */
function FakesCard({
  sourceCounts,
  canDelete,
}: {
  sourceCounts: Record<ReviewSource, number>;
  canDelete: boolean;
}) {
  const router = useRouter();
  const [confirm, setConfirm] = useState<"manual" | "ai" | null>(null);
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-[16px] border border-dashed border-border bg-[#fbf9f8] p-4 text-[14px]">
      <p className="text-muted-foreground">
        Avis factices :{" "}
        <span className="font-bold text-foreground">{sourceCounts.manual}</span> manuels ·{" "}
        <span className="font-bold text-foreground">{sourceCounts.ai}</span> IA. La suppression
        groupée ne touche jamais les avis clients.
      </p>
      {canDelete && (
      <div className="flex gap-2">
        <button
          type="button"
          disabled={sourceCounts.manual === 0}
          onClick={() => setConfirm("manual")}
          className="inline-flex items-center gap-1.5 rounded-full border-[1.5px] border-input bg-card px-3 py-1.5 text-xs font-bold text-destructive transition hover:bg-destructive/10 disabled:opacity-40"
        >
          <Trash2 className="h-3.5 w-3.5" /> Supprimer les manuels
        </button>
        <button
          type="button"
          disabled={sourceCounts.ai === 0}
          onClick={() => setConfirm("ai")}
          className="inline-flex items-center gap-1.5 rounded-full border-[1.5px] border-input bg-card px-3 py-1.5 text-xs font-bold text-destructive transition hover:bg-destructive/10 disabled:opacity-40"
        >
          <Trash2 className="h-3.5 w-3.5" /> Supprimer les IA
        </button>
      </div>
      )}
      {confirm && (
        <ConfirmDeleteModal
          title={`Supprimer tous les avis ${confirm === "ai" ? "IA" : "manuels"} ?`}
          description={`${confirm === "ai" ? sourceCounts.ai : sourceCounts.manual} avis seront supprimés définitivement et les notes produits recalculées. Les avis clients ne sont pas touchés.`}
          onCancel={() => setConfirm(null)}
          onConfirm={async () => {
            const res = await deleteReviewsBySourceAction(confirm);
            if (!res.ok) return res.message ?? "Erreur";
            router.refresh();
            return null;
          }}
        />
      )}
    </div>
  );
}

function ReviewRow({ review, perm }: { review: AdminReview; perm: ReviewPerm }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const showActions = perm.moderate || perm.delete;

  // Surface the ActionState — a refused approve/reject (e.g. « Avis introuvable »
  // after another moderator deleted it) used to vanish silently.
  const run = (fn: () => Promise<ActionState>) =>
    startTransition(async () => {
      setError(null);
      try {
        const res = await fn();
        if (!res.ok) {
          setError(res.message ?? "Action impossible.");
          return;
        }
      } catch {
        setError("Action impossible. Réessayez.");
        return;
      }
      router.refresh();
    });

  return (
    <li className="rounded-[16px] border border-border bg-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <StarRating value={review.rating} size="sm" />
          <span
            className={`inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-bold uppercase ${REVIEW_STATUS_COLORS[review.status]}`}
          >
            {REVIEW_STATUS_LABELS[review.status]}
          </span>
          <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-bold uppercase ${SOURCE_COLOR[review.source]}`}>
            {SOURCE_LABEL[review.source]}
          </span>
          {review.verifiedPurchase && (
            <span className="inline-flex items-center gap-1 rounded-full bg-[#eaf7ee] px-2.5 py-1 text-[11px] font-bold text-[#15803d]">
              <ShieldCheck className="h-3 w-3" /> Achat vérifié
            </span>
          )}
        </div>
        <time className="text-[12px] text-muted-foreground">
          {new Date(review.createdAt).toLocaleDateString("fr-FR", { dateStyle: "medium" })}
        </time>
      </div>

      <p className="mt-2 text-[14px] font-bold text-foreground">{review.title}</p>
      <p className="mt-1 line-clamp-3 text-sm text-muted-foreground" dir="auto">{review.body}</p>
      <p className="mt-2 text-[12px] text-muted-foreground">
        par <span className="font-bold text-foreground">{review.authorName}</span> ·{" "}
        {review.productSlug && review.productState === "live" ? (
          <Link href={`/${review.productSlug}`} className="text-primary hover:underline">
            {review.productName}
          </Link>
        ) : (
          review.productName
        )}
        {review.productState !== "live" && (
          <span className="ml-1.5 inline-flex items-center rounded-full bg-[#fff4e0] px-2 py-0.5 text-[10px] font-bold uppercase text-[#b45309]">
            {review.productState === "deleted" ? "produit supprimé" : "non publié"}
          </span>
        )}
      </p>

      {showActions && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {perm.moderate && review.status !== "approved" && (
            <button
              type="button"
              disabled={pending}
              onClick={() => run(() => setReviewStatusAction(review.id, "approved"))}
              className="inline-flex items-center gap-1.5 rounded-full bg-[#15803d] px-3 py-1.5 text-xs font-bold text-white transition hover:brightness-110 disabled:opacity-60"
            >
              <Check className="h-3.5 w-3.5" /> Approuver
            </button>
          )}
          {perm.moderate && review.status !== "rejected" && (
            <button
              type="button"
              disabled={pending}
              onClick={() => run(() => setReviewStatusAction(review.id, "rejected"))}
              className="inline-flex items-center gap-1.5 rounded-full border-[1.5px] border-input bg-card px-3 py-1.5 text-xs font-bold text-foreground transition hover:bg-surface disabled:opacity-60"
            >
              <X className="h-3.5 w-3.5" /> Rejeter
            </button>
          )}
          {perm.delete && (
            <button
              type="button"
              disabled={pending}
              onClick={() => setConfirmDelete(true)}
              className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-bold text-destructive transition hover:bg-destructive/10 disabled:opacity-60"
            >
              <Trash2 className="h-3.5 w-3.5" /> Supprimer
            </button>
          )}
          {pending && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
        </div>
      )}
      {error && (
        <p role="alert" className="mt-2 text-[13px] text-destructive">
          {error}
        </p>
      )}

      {confirmDelete && (
        <ConfirmDeleteModal
          title="Supprimer cet avis ?"
          description={`« ${review.title} » par ${review.authorName} sera supprimé définitivement et la note du produit recalculée.`}
          onCancel={() => setConfirmDelete(false)}
          onConfirm={async () => {
            const res = await deleteReviewAction(review.id);
            if (!res.ok) return res.message ?? "Suppression impossible.";
            router.refresh();
            return null; // the modal closes itself via onCancel
          }}
        />
      )}
    </li>
  );
}

// ─────────────────────────────────────────────── Manual review create modal
function ManualReviewModal({ config, onClose }: { config: ReviewConfig; onClose: () => void }) {
  const router = useRouter();
  // A manual review is source='manual'. It only feeds the public star rating
  // when the "Note publique" setting counts all approved reviews; under the
  // recommended "Avis clients uniquement" (ratingSource === "customers") the
  // recompute excludes manual/AI rows, so publishing it NEVER moves the stars.
  // Keep the copy honest with that setting (don't promise "compte dans la note").
  const countsTowardRating = config.ratingSource === "all";
  const [product, setProduct] = useState<RelatedProductOption | null>(null);
  const [rating, setRating] = useState(5);
  // Lazy initializer (runs once, not in render) → today's date for the picker max.
  const [today] = useState(() => new Date().toISOString().slice(0, 10));
  const [state, formAction, pending] = useActionState<ActionState | null, FormData>(
    createManualReviewAction,
    null,
  );

  useEffect(() => {
    if (state?.ok) {
      router.refresh();
      onClose();
    }
  }, [state, router, onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Créer un avis"
      className="fixed inset-0 z-50 grid place-items-center bg-foreground/40 p-4 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="flex max-h-[90vh] w-full max-w-lg flex-col overflow-hidden rounded-[28px] border border-border bg-card shadow-soft">
        <div className="flex items-start gap-3 border-b border-border p-5">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-[14px] bg-[#eef2ff] text-[#3730a3]">
            <UserPen className="h-4 w-4" />
          </span>
          <div className="min-w-0 flex-1">
            <h3 className="text-[18px] font-black text-foreground">Créer un avis manuel</h3>
            <p className="mt-0.5 text-[13px] text-muted-foreground">
              Avis factice attribué à un produit. Par défaut « en attente » ;{" "}
              {countsTowardRating
                ? "publiez-le pour qu'il compte dans la note."
                : "publiez-le pour qu'il apparaisse sur la fiche (exclu de la note publique selon vos réglages)."}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Fermer"
            className="grid h-9 w-9 place-items-center rounded-[11px] bg-surface text-muted-foreground transition hover:bg-secondary hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        <form action={formAction} className="min-h-0 flex-1 space-y-4 overflow-y-auto p-5">
          <ProductPicker selected={product} onSelect={setProduct} />
          <input type="hidden" name="productId" value={product?.id ?? ""} />

          <div className="grid gap-3 sm:grid-cols-2">
            <Field name="authorName" label="Auteur" required placeholder="Aymen B." maxLength={80} />
            <div>
              <span id="manual-rating-label" className="text-[13px] font-bold text-foreground">
                Note
              </span>
              <div
                role="radiogroup"
                aria-labelledby="manual-rating-label"
                className="mt-1 flex items-center gap-1"
              >
                {[1, 2, 3, 4, 5].map((n) => (
                  <button
                    key={n}
                    type="button"
                    role="radio"
                    aria-checked={n === rating}
                    onClick={() => setRating(n)}
                    aria-label={`${n} étoile${n > 1 ? "s" : ""}`}
                    className={`text-2xl leading-none transition ${n <= rating ? "text-[#f59e0b]" : "text-border"}`}
                  >
                    ★
                  </button>
                ))}
              </div>
              <input type="hidden" name="rating" value={rating} />
            </div>
          </div>

          <Field name="title" label="Titre" required placeholder="Super produit" maxLength={120} />
          <div>
            <label
              htmlFor="manual-body"
              className="text-[13px] font-bold text-foreground"
            >
              Avis <span className="text-destructive">*</span>
            </label>
            <textarea
              id="manual-body"
              name="body"
              required
              rows={4}
              dir="auto"
              maxLength={4000}
              placeholder="Texte de l'avis…"
              className="mt-1 w-full rounded-[14px] border-[1.5px] border-input bg-[#fbf9f8] px-4 py-2.5 text-[14px] focus:border-foreground focus:bg-white focus:outline-none"
            />
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <SelectField
              name="status"
              label="Statut"
              defaultValue="pending"
              options={[
                { value: "pending", label: "En attente (modération)" },
                {
                  value: "approved",
                  label: countsTowardRating
                    ? "Publié (compte dans la note)"
                    : "Publié (visible, exclu de la note)",
                },
              ]}
            />
            <Field name="createdAt" label="Date (optionnel)" type="date" max={today} />
          </div>

          {/* No "Achat vérifié" option for manual reviews: a curated review has no
              purchase behind it, so it must never pose as a verified buyer (the
              workflow forces verified_purchase=false). */}

          {state && !state.ok && (
            <p className="rounded-[14px] border border-destructive/40 bg-destructive/5 p-3 text-[13px] text-destructive">
              {state.message}
            </p>
          )}

          <div className="flex justify-end gap-2 border-t border-border pt-4">
            <button
              type="button"
              onClick={onClose}
              className="inline-flex h-11 items-center rounded-full border-[1.5px] border-input bg-card px-4 text-[14px] font-bold text-foreground hover:bg-surface"
            >
              Annuler
            </button>
            <button
              type="submit"
              disabled={pending || !product}
              className="inline-flex h-11 items-center gap-2 rounded-full bg-primary px-5 text-[14px] font-extrabold text-primary-foreground hover:bg-[#b8042a] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              Créer l&apos;avis
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/** Debounced product search → pick one product for the manual review. */
function ProductPicker({
  selected,
  onSelect,
}: {
  selected: RelatedProductOption | null;
  onSelect: (p: RelatedProductOption | null) => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<RelatedProductOption[]>([]);
  const [searching, startSearch] = useTransition();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (selected || query.trim().length < 2) {
      setResults([]);
      return;
    }
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      startSearch(async () => {
        try {
          setResults(await searchProductsForPickerAction(query));
        } catch {
          setResults([]);
        }
      });
    }, 250);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [query, selected]);

  if (selected) {
    return (
      <div>
        <span className="text-[13px] font-bold text-foreground">
          Produit
        </span>
        <div className="mt-1 flex items-center justify-between gap-2 rounded-[14px] border-[1.5px] border-primary/40 bg-[var(--accent)] px-3 py-2">
          <span className="truncate text-[14px] font-bold text-foreground">{selected.name}</span>
          <button
            type="button"
            onClick={() => {
              onSelect(null);
              setQuery("");
            }}
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            Changer
          </button>
        </div>
      </div>
    );
  }

  return (
    <div>
      <label
        htmlFor="manual-product"
        className="text-[13px] font-bold text-foreground"
      >
        Produit <span className="text-destructive">*</span>
      </label>
      <div className="relative mt-1">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <input
          id="manual-product"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Rechercher un produit…"
          className="h-11 w-full rounded-[14px] border-[1.5px] border-input bg-[#fbf9f8] pl-10 pr-3 text-[15px] focus:border-foreground focus:bg-white focus:outline-none"
        />
        {searching && (
          <Loader2 className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-muted-foreground" />
        )}
      </div>
      {results.length > 0 && (
        <ul className="mt-2 max-h-48 space-y-1 overflow-y-auto rounded-[14px] border border-border bg-[#fbf9f8] p-1">
          {results.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                onClick={() => onSelect(p)}
                className="block w-full truncate rounded-[10px] px-3 py-2 text-left text-[14px] hover:bg-card"
              >
                {p.name}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Field({
  name,
  label,
  required,
  type,
  placeholder,
  maxLength,
  max,
}: {
  name: string;
  label: string;
  required?: boolean;
  type?: string;
  placeholder?: string;
  maxLength?: number;
  max?: string;
}) {
  const id = `manual-${name}`;
  return (
    <div>
      <label
        htmlFor={id}
        className="text-[13px] font-bold text-foreground"
      >
        {label}
        {required && <span className="text-destructive"> *</span>}
      </label>
      <input
        id={id}
        name={name}
        type={type ?? "text"}
        required={required}
        placeholder={placeholder}
        maxLength={maxLength}
        max={max}
        className="mt-1 h-11 w-full rounded-[14px] border-[1.5px] border-input bg-[#fbf9f8] px-4 text-[14px] focus:border-foreground focus:bg-white focus:outline-none"
      />
    </div>
  );
}
