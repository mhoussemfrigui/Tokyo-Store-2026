"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { createPortal } from "react-dom";
import { Plus, Power, Trash2, X } from "lucide-react";

import { ConfirmDeleteModal } from "@/components/admin/confirm-delete-modal";
import { IconButton } from "@/components/admin/icon-button";
import { PromotionForm } from "@/app/admin/promotions/promotion-form";
import {
  deletePromotionAction,
  togglePromotionActiveAction,
} from "@/lib/actions/promotion";
import { formatDate as fmtDateShort } from "@/lib/format/date";
import { formatMoneyExact } from "@/lib/price";

/**
 * Inline panel that lives below the product form on the edit page and lists
 * every promotion targeting this product (scope='product', scope_id=productId).
 * "Nouvelle promotion" opens the SAME `PromotionForm` in an on-page MODAL
 * (portaled to <body> so its <form> isn't nested inside the product form),
 * pre-scoped + auto-named to this product — so the merchant never leaves the
 * page nor types a name, while the global promotion module stays the
 * single source of truth (same server action, no duplicate CRUD plumbing).
 */

export type ProductPromotionRow = {
  id: string;
  name: string;
  triggerKind: "auto" | "code" | "url";
  code: string | null;
  urlSlug: string | null;
  discountType: "percent" | "fixed";
  discountValue: number;
  startsAt: string | null;
  endsAt: string | null;
  isActive: boolean;
  usesCount: number;
  maxUses: number | null;
};

function formatDiscount(p: ProductPromotionRow): string {
  return p.discountType === "percent"
    ? `−${p.discountValue}%`
    : `−${formatMoneyExact(p.discountValue)}`;
}

function formatDate(iso: string | null): string {
  return iso ? fmtDateShort(iso) : "—";
}

function statusFor(p: ProductPromotionRow): {
  label: string;
  tone: "ok" | "muted" | "warn" | "ko";
} {
  if (!p.isActive) return { label: "Désactivée", tone: "muted" };
  const now = Date.now();
  if (p.startsAt && Date.parse(p.startsAt) > now)
    return { label: "À venir", tone: "warn" };
  if (p.endsAt && Date.parse(p.endsAt) <= now)
    return { label: "Expirée", tone: "ko" };
  return { label: "Active", tone: "ok" };
}

const TONE_CLASS: Record<"ok" | "muted" | "warn" | "ko", string> = {
  ok: "bg-[#eaf7ee] text-[#15803d]",
  muted: "bg-muted text-muted-foreground",
  warn: "bg-[#fff4e0] text-[#b45309]",
  ko: "bg-[var(--accent)] text-destructive",
};

export function ProductPromotionsPanel({
  productId,
  productName,
  promotions,
  priceReduction = null,
  canCreate = true,
  canUpdate = true,
  canDelete = true,
}: {
  productId: string;
  /** Product display name — locks + auto-names the inline "Nouvelle promotion" modal. */
  productName: string;
  promotions: ProductPromotionRow[];
  /** DIRECT markdown set in the Prix tab (ancien prix > prix), mirrored live so
   *  the operator sees the price reduction here too. Null = no markdown. */
  priceReduction?: { oldCents: number; newCents: number } | null;
  /** promotions:create — gates « Nouvelle promotion ». The create action
   *  requirePermission()s and notFound()s on deny, which would tear down the
   *  product editor, so a view-only operator must not see the control. */
  canCreate?: boolean;
  /** promotions:update — gates the per-row activate/deactivate toggle. */
  canUpdate?: boolean;
  /** promotions:delete — gates the per-row delete. */
  canDelete?: boolean;
}) {
  const router = useRouter();
  const [toDelete, setToDelete] = useState<ProductPromotionRow | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  return (
    <section className="space-y-3 rounded-3xl border border-border bg-card p-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-[14.5px]">
            Promotions sur ce produit
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Réductions automatiques, codes et URL partageables ciblant ce
            produit. Créées ici sans quitter la page ; aussi modifiables depuis
            le module global.
          </p>
        </div>
        {/* Gate on promotions:create — the create action THROWS notFound() on
            deny (flat RBAC: view ≠ create), which would replace the product
            editor with the 404 boundary, so a view-only operator must not see it. */}
        {canCreate && (
          <button
            type="button"
            onClick={() => setShowCreate(true)}
            className="inline-flex h-9 items-center gap-1.5 rounded-full bg-foreground px-3.5 text-xs font-semibold text-background"
          >
            <Plus className="h-3.5 w-3.5" /> Nouvelle promotion
          </button>
        )}
      </header>

      {/* Direct markdown from the Prix tab (ancien prix barré) — reflected here so
          promotions + the direct price reduction read as one place. Updates live
          as the operator edits the price. */}
      {priceReduction && priceReduction.oldCents > priceReduction.newCents && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-[#cdebd6] bg-[#eaf7ee] p-3.5">
          <div className="min-w-0">
            <p className="text-[13px] font-semibold text-foreground">Réduction directe en prix</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Définie dans l&apos;onglet <strong>Prix</strong> (ancien prix barré) — s&apos;applique à tous, en plus des promotions ci-dessous.
            </p>
          </div>
          <div className="shrink-0 text-right">
            <span className="inline-flex items-center rounded-full bg-[#d7f0df] px-2.5 py-1 text-sm font-bold text-[#15803d]">
              −{Math.round(((priceReduction.oldCents - priceReduction.newCents) / priceReduction.oldCents) * 100)}%
            </span>
            <p className="mt-1 text-xs text-muted-foreground">
              <s>{formatMoneyExact(priceReduction.oldCents)}</s>{" "}
              →{" "}
              <span className="font-semibold text-foreground">{formatMoneyExact(priceReduction.newCents)}</span>
            </p>
          </div>
        </div>
      )}

      {promotions.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border bg-surface/40 p-6 text-center text-xs text-muted-foreground">
          Aucune promotion ne cible directement ce produit. Les promotions
          de catégorie ou de marque s&apos;appliqueront automatiquement si
          elles correspondent.
        </div>
      ) : (
        <ul className="divide-y divide-border rounded-2xl border border-border bg-background">
          {promotions.map((p) => (
            <PromotionListItem
              key={p.id}
              promo={p}
              canUpdate={canUpdate}
              canDelete={canDelete}
              onDelete={() => setToDelete(p)}
            />
          ))}
        </ul>
      )}

      {toDelete && (
        <ConfirmDeleteModal
          title="Supprimer la promotion ?"
          description={`« ${toDelete.name} » sera supprimée. Les redemptions passées restent en historique.`}
          onCancel={() => setToDelete(null)}
          onConfirm={async () => {
            const res = await deletePromotionAction(toDelete.id);
            if (res.ok) {
              setToDelete(null);
              return null;
            }
            return res.message;
          }}
        />
      )}

      {showCreate && (
        <CreatePromotionModal
          productId={productId}
          productName={productName}
          onClose={() => setShowCreate(false)}
          onSuccess={() => {
            setShowCreate(false);
            router.refresh();
          }}
        />
      )}
    </section>
  );
}

/**
 * On-page "create a promotion for this product" modal. Portaled to <body> so
 * the reused PromotionForm's <form> is NOT nested inside the product editor's
 * form. Scope is locked to the product and the (customer-facing) name is auto-generated.
 */
function CreatePromotionModal({
  productId,
  productName,
  onClose,
  onSuccess,
}: {
  productId: string;
  productName: string;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [mounted, setMounted] = useState(false);
  // Submit-in-flight: while true, every dismissal path is ignored so closing
  // mid-submit can't unmount the form before onSuccess runs (→ phantom create +
  // no list refresh). PromotionForm reports it via onPendingChange.
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const closeBtnRef = useRef<HTMLButtonElement | null>(null);
  const openerRef = useRef<Element | null>(null);

  const guardedClose = () => {
    if (!submittingRef.current) onClose();
  };

  useEffect(() => setMounted(true), []);
  useEffect(() => {
    // Remember the opener + move focus into the dialog; restore focus on close.
    openerRef.current = document.activeElement;
    const focusTimer = window.setTimeout(() => closeBtnRef.current?.focus(), 0);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !submittingRef.current) onClose();
    };
    window.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.clearTimeout(focusTimer);
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
      (openerRef.current as HTMLElement | null)?.focus?.();
    };
  }, [onClose]);

  if (!mounted) return null;

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Nouvelle promotion"
      className="fixed inset-0 z-50 grid justify-center overflow-y-auto bg-foreground/40 p-4 backdrop-blur-sm sm:p-6"
      onClick={(e) => {
        if (e.target === e.currentTarget) guardedClose();
      }}
    >
      <div className="my-auto w-full max-w-2xl rounded-3xl border border-border bg-card p-5 shadow-soft sm:p-6">
        <div className="mb-4 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="font-display text-lg font-bold text-foreground">
              Nouvelle promotion
            </h3>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Ciblée sur « {productName} » — le nom affiché au client est généré automatiquement.
            </p>
          </div>
          <button
            ref={closeBtnRef}
            type="button"
            onClick={guardedClose}
            disabled={submitting}
            aria-label="Fermer"
            className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-muted-foreground transition hover:bg-surface disabled:opacity-40"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <PromotionForm
          mode="create"
          products={[{ id: productId, name: productName }]}
          categories={[]}
          brands={[]}
          cancelHref=""
          lockScope={{ scope: "product", id: productId }}
          autoName={productName}
          onSuccess={onSuccess}
          onCancel={guardedClose}
          onPendingChange={(p) => {
            submittingRef.current = p;
            setSubmitting(p);
          }}
        />
      </div>
    </div>,
    document.body,
  );
}

function PromotionListItem({
  promo,
  canUpdate,
  canDelete,
  onDelete,
}: {
  promo: ProductPromotionRow;
  canUpdate: boolean;
  canDelete: boolean;
  onDelete: () => void;
}) {
  const status = statusFor(promo);
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <li className="flex flex-wrap items-center gap-3 px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-2">
          <Link
            href={`/admin/promotions/${promo.id}`}
            className="font-medium text-foreground hover:underline"
          >
            {promo.name}
          </Link>
          <span className="font-mono text-xs text-primary">
            {formatDiscount(promo)}
          </span>
        </div>
        <p className="mt-0.5 text-[11px] text-muted-foreground">
          {promo.triggerKind === "code" && promo.code
            ? `Code ${promo.code} · `
            : promo.triggerKind === "url" && promo.urlSlug
              ? `/promo/${promo.urlSlug} · `
              : "Automatique · "}
          {formatDate(promo.startsAt)} → {formatDate(promo.endsAt)}
          {promo.maxUses
            ? ` · ${promo.usesCount}/${promo.maxUses} utilisations`
            : ` · ${promo.usesCount} utilisations`}
        </p>
      </div>
      <span
        className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${TONE_CLASS[status.tone]}`}
      >
        {status.label}
      </span>
      {/* Toggle/delete gated on promotions:update / :delete — their actions
          notFound() on deny, so a view-only operator must not see controls that
          would tear down the product editor. */}
      {(canUpdate || canDelete) && (
        <div className="flex shrink-0 items-center gap-1">
          {canUpdate && (
            <IconButton
              aria-label={promo.isActive ? "Désactiver" : "Activer"}
              size="sm"
              disabled={isPending}
              icon={
                <Power
                  className={`h-3.5 w-3.5 ${promo.isActive ? "text-[#15803d]" : "text-muted-foreground"}`}
                />
              }
              onClick={() =>
                startTransition(async () => {
                  setError(null);
                  try {
                    const res = await togglePromotionActiveAction(promo.id, !promo.isActive);
                    if (!res.ok) setError(res.message || "La modification n'a pas pu être enregistrée.");
                  } catch {
                    setError("La modification n'a pas pu être enregistrée.");
                  }
                })
              }
            />
          )}
          {canDelete && (
            <IconButton
              aria-label="Supprimer"
              size="sm"
              tone="danger"
              onClick={onDelete}
              icon={<Trash2 className="h-3.5 w-3.5" />}
            />
          )}
        </div>
      )}
      {error && (
        <p role="alert" className="w-full text-[11px] font-medium text-destructive">
          {error}
        </p>
      )}
    </li>
  );
}
