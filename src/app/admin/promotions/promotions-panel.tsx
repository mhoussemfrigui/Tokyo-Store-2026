"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import {
  ChevronDown,
  Copy,
  Plus,
  Power,
  Tag,
  Trash2,
} from "lucide-react";

import { formatDateLong } from "@/lib/format/date";
import { formatMoneyExact, minorToDinars } from "@/lib/price";

import { AdminToolbar, SegmentedFilter, AdminSearch, AdminNote } from "@/components/admin/_components/filter-bar";
import { ConfirmDeleteModal } from "@/components/admin/confirm-delete-modal";
import { IconButton } from "@/components/admin/icon-button";
import {
  clonePromotionAction,
  deletePromotionAction,
  togglePromotionActiveAction,
} from "@/lib/actions/promotion";

export type AdminPromotionRow = {
  id: string;
  name: string;
  triggerKind: "auto" | "code" | "url";
  code: string | null;
  urlSlug: string | null;
  scope: "product" | "category" | "brand" | "cart" | "targeted";
  scopeId: string | null;
  scopeLabel: string | null;
  /** MULTI-target (scope='targeted') size — how many products/categories/brands. */
  scopeTargetCount?: number;
  discountType: "percent" | "fixed";
  discountValue: number;
  minCartCents: number;
  startsAt: string | null;
  endsAt: string | null;
  isActive: boolean;
  isStackable: boolean;
  usesCount: number;
  maxUses: number | null;
  /** 0 = public (all customers); >0 = restricted to that many targets. */
  targetCount: number;
};

const SCOPE_LABEL: Record<AdminPromotionRow["scope"], string> = {
  product: "Produit",
  category: "Catégorie",
  brand: "Marque",
  cart: "Panier",
  targeted: "Ciblage multiple",
};

const TRIGGER_LABEL: Record<AdminPromotionRow["triggerKind"], string> = {
  auto: "Auto",
  code: "Code",
  url: "URL",
};

function formatDiscount(row: AdminPromotionRow): string {
  return row.discountType === "percent"
    ? `−${row.discountValue}%`
    : `−${formatMoneyExact(row.discountValue)}`;
}

function formatDate(iso: string | null): string {
  return iso ? formatDateLong(iso) : "—";
}

/**
 * Live-status badge.
 *
 *   - "expirée"   → ends_at passed
 *   - "à venir"   → starts_at in future
 *   - "active"    → currently in window AND is_active=true
 *   - "désactivée"→ is_active=false (even if in window)
 *
 * Computed client-side off the timestamps the server sent — close enough
 * for an admin grid where a refresh is one click away.
 */
function statusFor(row: AdminPromotionRow): {
  label: string;
  tone: "ok" | "muted" | "warn" | "ko";
} {
  if (!row.isActive) return { label: "Désactivée", tone: "muted" };
  const now = Date.now();
  if (row.startsAt && Date.parse(row.startsAt) > now)
    return { label: "À venir", tone: "warn" };
  if (row.endsAt && Date.parse(row.endsAt) <= now)
    return { label: "Expirée", tone: "ko" };
  return { label: "Active", tone: "ok" };
}

const EXPIRES_SOON_MS = 7 * 24 * 60 * 60 * 1000; // 7 days.

/**
 * True when an ACTIVE, currently-live promo ends within the next 7 days — a
 * heads-up badge for ops. Disabled/upcoming/already-expired promos don't
 * qualify (their main status badge already tells the story).
 */
function expiresSoon(row: AdminPromotionRow): boolean {
  if (!row.isActive || !row.endsAt) return false;
  const now = Date.now();
  if (row.startsAt && Date.parse(row.startsAt) > now) return false; // upcoming
  const ends = Date.parse(row.endsAt);
  return Number.isFinite(ends) && ends > now && ends - now <= EXPIRES_SOON_MS;
}

const TONE_CLASS: Record<"ok" | "muted" | "warn" | "ko", string> = {
  ok: "bg-[#eaf7ee] text-[#15803d]",
  muted: "bg-[#f6f2ed] text-[#5b5d62]",
  warn: "bg-[#fff4e0] text-[#b45309]",
  ko: "bg-[#fdecef] text-[#d40530]",
};

export function PromotionsListPanel({
  promotions,
  createHref,
  total,
  page,
  pageSize,
  currentSearch,
  currentTrigger,
  canManage,
}: {
  promotions: AdminPromotionRow[];
  createHref: string;
  /** SERVER pagination + filter state (the page loads exactly one page). */
  total: number;
  page: number;
  pageSize: number;
  currentSearch: string;
  currentTrigger: "all" | "auto" | "code" | "url";
  /** promotions:create/update/delete — hides the create button + row write actions. */
  canManage: boolean;
}) {
  const router = useRouter();
  const [search, setSearch] = useState(currentSearch);
  const [toDelete, setToDelete] = useState<AdminPromotionRow | null>(null);

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  // Navigate the SERVER list — resets to page 1 whenever a filter changes.
  const nav = (next: { q?: string; trigger?: string; page?: number }) => {
    const p = new URLSearchParams();
    const q = next.q ?? currentSearch;
    const trigger = next.trigger ?? currentTrigger;
    if (q.trim()) p.set("q", q.trim());
    if (trigger && trigger !== "all") p.set("trigger", trigger);
    if (next.page && next.page > 1) p.set("page", String(next.page));
    const qs = p.toString();
    router.push(qs ? `/admin/promotions?${qs}` : "/admin/promotions");
  };

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-3 rounded-[22px] border border-border bg-card px-5 py-4">
        <AdminNote className="max-w-3xl">
          Codes coupon, promotions auto par catégorie / marque / produit, et
          URL partageables. Visibles côté boutique dès qu&apos;elles sont
          actives et dans leur fenêtre temporelle.
        </AdminNote>
        {canManage && (
          <Link
            href={createHref}
            className="inline-flex h-11 items-center gap-2 rounded-full bg-primary px-5 text-[14px] font-extrabold text-primary-foreground hover:bg-[#b8042a]"
          >
            <Plus className="h-4 w-4" /> Nouvelle promotion
          </Link>
        )}
      </header>

      <AdminToolbar>
        <form
          onSubmit={(e) => { e.preventDefault(); nav({ q: search, page: 1 }); }}
          className="min-w-[16rem] flex-1"
        >
          <AdminSearch
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Rechercher par nom, code ou URL…"
            className="w-full"
          />
        </form>
        <SegmentedFilter<"all" | "auto" | "code" | "url">
          ariaLabel="Filtrer par déclencheur"
          value={currentTrigger}
          onChange={(t) => nav({ trigger: t, page: 1 })}
          options={[
            { value: "all", label: "Tous" },
            { value: "auto", label: TRIGGER_LABEL.auto },
            { value: "code", label: TRIGGER_LABEL.code },
            { value: "url", label: TRIGGER_LABEL.url },
          ]}
        />
        <span className="px-1 text-xs text-muted-foreground">{total} promotion{total > 1 ? "s" : ""}</span>
      </AdminToolbar>

      {promotions.length === 0 ? (
        <div className="rounded-3xl border border-dashed border-border bg-card p-12 text-center text-sm text-muted-foreground">
          Aucune promotion pour ce filtre.{canManage ? " Créez la première via le bouton ci-dessus." : ""}
        </div>
      ) : (
        <ul className="space-y-2">
          {promotions.map((p) => (
            <PromotionRow key={p.id} promo={p} onDelete={() => setToDelete(p)} canManage={canManage} />
          ))}
        </ul>
      )}

      {totalPages > 1 && (
        <nav className="flex items-center justify-between gap-3" aria-label="Pagination des promotions">
          <button
            type="button"
            disabled={page <= 1}
            onClick={() => nav({ page: page - 1 })}
            className="inline-flex h-9 items-center rounded-full border border-border bg-card px-4 text-[12px] font-semibold text-foreground hover:bg-surface disabled:opacity-40"
          >
            ← Précédent
          </button>
          <span className="text-[12px] text-muted-foreground">Page {page} / {totalPages}</span>
          <button
            type="button"
            disabled={page >= totalPages}
            onClick={() => nav({ page: page + 1 })}
            className="inline-flex h-9 items-center rounded-full border border-border bg-card px-4 text-[12px] font-semibold text-foreground hover:bg-surface disabled:opacity-40"
          >
            Suivant →
          </button>
        </nav>
      )}

      {toDelete && (
        <ConfirmDeleteModal
          title="Supprimer la promotion ?"
          description={`« ${toDelete.name} » sera supprimée. Les redemptions passées restent dans l'historique mais la promo n'apparaîtra plus côté boutique.`}
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
    </div>
  );
}

function PromotionRow({
  promo,
  onDelete,
  canManage,
}: {
  promo: AdminPromotionRow;
  onDelete: () => void;
  canManage: boolean;
}) {
  const status = statusFor(promo);
  const soon = expiresSoon(promo);
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <li className="rounded-[22px] border border-border bg-card">
      <div className="flex flex-wrap items-center gap-3 p-4 sm:p-5">
        <span
          className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-foreground text-background`}
        >
          <Tag className="h-4 w-4" strokeWidth={2} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-2">
            <Link
              href={`/admin/promotions/${promo.id}`}
              className="text-[14.5px] text-foreground hover:underline"
            >
              {promo.name}
            </Link>
            <span className="font-mono text-sm text-primary">
              {formatDiscount(promo)}
            </span>
          </div>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {SCOPE_LABEL[promo.scope]}
            {promo.scope === "targeted"
              ? promo.scopeTargetCount
                ? ` · ${promo.scopeTargetCount} cible${promo.scopeTargetCount > 1 ? "s" : ""}`
                : ""
              : promo.scopeLabel
                ? ` · ${promo.scopeLabel}`
                : ""}
            {" · "}
            {TRIGGER_LABEL[promo.triggerKind]}
            {promo.code ? ` · code ${promo.code}` : ""}
            {promo.urlSlug ? ` · /promo/${promo.urlSlug}` : ""}
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          {promo.targetCount > 0 && (
            <span
              className="rounded-full bg-primary/10 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wider text-primary"
              title="Réservée à des clients / segments ciblés"
            >
              Ciblée ({promo.targetCount})
            </span>
          )}
          {soon && (
            <span className="rounded-full bg-[#fff4e0] px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wider text-[#b45309]">
              Expire bientôt
            </span>
          )}
          <span
            className={`rounded-full px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wider ${TONE_CLASS[status.tone]}`}
          >
            {status.label}
          </span>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          {canManage && (<>
          <IconButton
            aria-label={promo.isActive ? "Désactiver" : "Activer"}
            size="sm"
            disabled={isPending}
            icon={
              <Power
                className={`h-3.5 w-3.5 ${promo.isActive ? "text-[#15803d]" : "text-muted-foreground"}`}
              />
            }
            onClick={() => {
              startTransition(async () => {
                setError(null);
                try {
                  const res = await togglePromotionActiveAction(promo.id, !promo.isActive);
                  if (!res.ok) setError(res.message || "La modification n'a pas pu être enregistrée.");
                } catch {
                  setError("La modification n'a pas pu être enregistrée.");
                }
              });
            }}
          />
          <IconButton
            aria-label="Dupliquer"
            size="sm"
            disabled={isPending}
            onClick={() => {
              startTransition(async () => {
                setError(null);
                try {
                  const res = await clonePromotionAction(promo.id);
                  if (!res.ok) {
                    setError(res.message || "La duplication a échoué.");
                    return;
                  }
                  // Open the inactive copy so the admin replaces its provisional
                  // code / slug before activating it.
                  if (res.id) router.push(`/admin/promotions/${res.id}`);
                } catch {
                  setError("La duplication a échoué.");
                }
              });
            }}
            icon={<Copy className="h-3.5 w-3.5" />}
          />
          <IconButton
            aria-label="Supprimer"
            size="sm"
            tone="danger"
            onClick={onDelete}
            icon={<Trash2 className="h-3.5 w-3.5" />}
          />
          </>)}
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="grid h-8 w-8 place-items-center rounded-lg text-muted-foreground transition hover:bg-surface hover:text-foreground"
            aria-label={expanded ? "Réduire" : "Développer"}
          >
            <ChevronDown
              className={`h-4 w-4 transition-transform ${expanded ? "rotate-180" : ""}`}
              strokeWidth={2}
            />
          </button>
        </div>
        {error && (
          <p role="alert" className="w-full text-[11px] font-medium text-destructive">
            {error}
          </p>
        )}
      </div>

      {expanded && (
        <dl className="grid gap-x-6 gap-y-2 border-t border-border px-4 pb-4 pt-3 text-xs text-muted-foreground sm:grid-cols-2 sm:px-5 sm:pb-5">
          <Row label="Début" value={formatDate(promo.startsAt)} />
          <Row label="Fin" value={formatDate(promo.endsAt)} />
          <Row
            label="Panier minimum"
            value={promo.minCartCents > 0 ? `${minorToDinars(promo.minCartCents)} TND` : "Aucun"}
          />
          <Row
            label="Utilisations"
            value={
              promo.maxUses
                ? `${promo.usesCount} / ${promo.maxUses}`
                : `${promo.usesCount} (illimité)`
            }
          />
          <Row label="Cumulable" value={promo.isStackable ? "Oui" : "Non"} />
        </dl>
      )}
    </li>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3">
      <dt>{label}</dt>
      <dd className="text-foreground">{value}</dd>
    </div>
  );
}
