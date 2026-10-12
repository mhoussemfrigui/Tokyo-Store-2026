"use client";

import { useState, useTransition } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ChevronLeft, ChevronRight, MailX, RotateCcw } from "lucide-react";

import {
  reactivateNewsletterSubscriberAction,
  unsubscribeNewsletterSubscriberAction,
} from "@/lib/actions/newsletter";
import { AdminPageHeader } from "@/components/admin/page-header";
import { ConfirmDeleteModal } from "@/components/admin/confirm-delete-modal";
import { ExportFieldPicker } from "@/components/admin/export-field-picker";
import { NEWSLETTER_EXPORT_FIELDS } from "@/lib/export/newsletter-fields";
import { AdminToolbar, AdminSearch, SegmentedFilter } from "@/components/admin/_components/filter-bar";

type Subscriber = {
  id: string;
  email: string;
  source: string;
  isActive: boolean;
  createdAt: string;
  unsubscribedAt: string | null;
};

type StatusTab = "active" | "all" | "inactive";
type Filters = { status: StatusTab; q: string };
type Pagination = { page: number; pageSize: number; total: number };

/**
 * Newsletter admin. Everything is SERVER-driven: the stat cards are SQL counts
 * over the whole table, the tabs / search / pagination live in the URL
 * (`status`, `q`, `page`) and the CSV is streamed by /api/admin/newsletter/export
 * with the same filters — nothing is capped to the rows loaded on this page.
 */
export function NewsletterPanel({
  subscribers,
  counts,
  filters,
  pagination,
  canManage,
  canExport,
}: {
  subscribers: Subscriber[];
  counts: { active: number; inactive: number; total: number };
  filters: Filters;
  pagination: Pagination;
  canManage: boolean;
  canExport: boolean;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [navigating, startNav] = useTransition();
  const [search, setSearch] = useState(filters.q);
  const totalPages = Math.max(1, Math.ceil(pagination.total / pagination.pageSize));

  function navigate(patch: { status?: StatusTab; q?: string; page?: number }) {
    const next = new URLSearchParams(searchParams.toString());
    if (patch.status !== undefined) {
      // "active" is the default view — keep the URL clean.
      if (patch.status === "active") next.delete("status");
      else next.set("status", patch.status);
    }
    if (patch.q !== undefined) {
      if (patch.q.trim()) next.set("q", patch.q.trim());
      else next.delete("q");
    }
    // A filter change restarts at page 1; an explicit page move keeps the filters.
    if (patch.page && patch.page > 1) next.set("page", String(patch.page));
    else next.delete("page");
    startNav(() => router.push(`?${next.toString()}`, { scroll: false }));
  }

  return (
    <div className="space-y-6">
      <AdminPageHeader
        title="Newsletter"
        description="Inscrits via le formulaire en pied de page. Export CSV (liste complète, selon le filtre affiché) pour synchroniser avec Resend / Mailjet / un autre ESP. Inscription en simple opt-in : les adresses ne sont pas vérifiées par un email de confirmation."
      />

      <div className="grid gap-3 sm:grid-cols-3">
        <StatCard label="Inscrits actifs" value={counts.active} tone="success" />
        <StatCard label="Désinscrits" value={counts.inactive} tone="muted" />
        <StatCard label="Total historique" value={counts.total} tone="muted" />
      </div>

      <AdminToolbar>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            navigate({ q: search });
          }}
          className="min-w-[200px] flex-1"
        >
          <AdminSearch
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Rechercher un email… (Entrée)"
            aria-label="Rechercher un email"
            className="w-full"
          />
        </form>
        <SegmentedFilter
          ariaLabel="Statut"
          value={filters.status}
          onChange={(v) => navigate({ status: v as StatusTab, q: search })}
          options={[
            { value: "active", label: "Actifs", count: counts.active },
            { value: "all", label: "Tous", count: counts.total },
            { value: "inactive", label: "Désinscrits", count: counts.inactive },
          ]}
        />
        {canExport && (
          <ExportFieldPicker
            baseUrl="/api/admin/newsletter/export"
            fields={NEWSLETTER_EXPORT_FIELDS}
            extraParams={{ status: filters.status, q: filters.q || undefined }}
          />
        )}
      </AdminToolbar>

      {subscribers.length === 0 ? (
        <div className="rounded-[22px] border border-dashed border-border bg-card p-12 text-center text-[14px] text-muted-foreground">
          Aucun inscrit pour ce filtre.
        </div>
      ) : (
        <ul
          className={`divide-y divide-border rounded-[22px] border border-border bg-card transition-opacity ${
            navigating ? "opacity-60" : ""
          }`}
        >
          {subscribers.map((s) => (
            <SubscriberRow key={s.id} subscriber={s} canManage={canManage} />
          ))}
        </ul>
      )}

      {pagination.total > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 px-1 text-sm">
          <p className="text-xs text-muted-foreground">
            {pagination.total} résultat{pagination.total > 1 ? "s" : ""} · page {pagination.page} /{" "}
            {totalPages}
          </p>
          <div className="inline-flex items-center gap-1">
            <button
              type="button"
              disabled={pagination.page <= 1 || navigating}
              onClick={() => navigate({ page: pagination.page - 1 })}
              className="inline-flex h-9 items-center gap-1 rounded-full border-[1.5px] border-input bg-card px-3 text-xs font-bold text-foreground hover:bg-surface disabled:opacity-40"
            >
              <ChevronLeft className="h-3.5 w-3.5" /> Précédent
            </button>
            <button
              type="button"
              disabled={pagination.page >= totalPages || navigating}
              onClick={() => navigate({ page: pagination.page + 1 })}
              className="inline-flex h-9 items-center gap-1 rounded-full border-[1.5px] border-input bg-card px-3 text-xs font-bold text-foreground hover:bg-surface disabled:opacity-40"
            >
              Suivant <ChevronRight className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function SubscriberRow({ subscriber, canManage }: { subscriber: Subscriber; canManage: boolean }) {
  // Both directions are CONSENT decisions and go through an explicit
  // confirmation stating the consequence — never a one-click action:
  //  - re-subscribing someone who opted out also turns the linked customer
  //    account's marketing opt-in back on;
  //  - « Désinscrire » (a removal / erasure request received by email or phone)
  //    withdraws marketing consent everywhere, linked account included. The row
  //    is kept as the suppression record so the address can't be re-mailed.
  const [confirming, setConfirming] = useState<"reactivate" | "unsubscribe" | null>(null);

  return (
    <li className="flex items-center justify-between gap-3 p-4">
      <div className="min-w-0">
        <p className="truncate text-sm font-semibold text-foreground">{subscriber.email}</p>
        <p className="text-[11px] text-muted-foreground">
          {subscriber.source} · inscrit le{" "}
          {new Date(subscriber.createdAt).toLocaleDateString("fr-FR")}
          {/* No « confirmé le »: the list is single-opt-in — confirmed_at is
              stamped at insert and proves nothing (see newsletter/schema.ts). */}
          {subscriber.unsubscribedAt && (
            <> · désinscrit le {new Date(subscriber.unsubscribedAt).toLocaleDateString("fr-FR")}</>
          )}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {!subscriber.isActive && canManage && (
          <button
            type="button"
            onClick={() => setConfirming("reactivate")}
            className="inline-flex h-8 items-center gap-1.5 rounded-full border-[1.5px] border-input bg-card px-3 text-[11px] font-bold text-foreground transition hover:bg-surface disabled:opacity-60"
          >
            <RotateCcw className="h-3 w-3" />
            Réactiver
          </button>
        )}
        {subscriber.isActive && canManage && (
          <button
            type="button"
            onClick={() => setConfirming("unsubscribe")}
            className="inline-flex h-8 items-center gap-1.5 rounded-full border-[1.5px] border-input bg-card px-3 text-[11px] font-bold text-foreground transition hover:bg-surface disabled:opacity-60"
          >
            <MailX className="h-3 w-3" />
            Désinscrire
          </button>
        )}
        {confirming === "reactivate" && (
          <ConfirmDeleteModal
            variant="neutral"
            icon={RotateCcw}
            title="Réabonner cette adresse ?"
            description={`${subscriber.email} s'est désinscrit·e. Ne la réabonnez que si la personne l'a demandé : elle recevra de nouveau les emails marketing, et le consentement marketing de son compte client (s'il existe) sera réactivé.`}
            confirmLabel="Réabonner"
            onCancel={() => setConfirming(null)}
            onConfirm={async () => {
              const res = await reactivateNewsletterSubscriberAction(subscriber.id);
              return res.ok ? null : res.message;
            }}
          />
        )}
        {confirming === "unsubscribe" && (
          <ConfirmDeleteModal
            variant="neutral"
            icon={MailX}
            title="Désinscrire cette adresse ?"
            description={`${subscriber.email} ne recevra plus aucun email marketing, et le consentement marketing de son compte client (s'il existe) sera retiré. L'adresse reste listée comme désinscrite pour ne plus être contactée ; elle pourra être réabonnée plus tard si la personne le demande.`}
            confirmLabel="Désinscrire"
            onCancel={() => setConfirming(null)}
            onConfirm={async () => {
              const res = await unsubscribeNewsletterSubscriberAction(subscriber.id);
              return res.ok ? null : res.message;
            }}
          />
        )}
        <span
          className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-bold ${
            subscriber.isActive
              ? "bg-[#fdecef] text-[#d40530]"
              : "bg-[#f6f2ed] text-[#5b5d62]"
          }`}
        >
          {subscriber.isActive ? "Actif" : "Désinscrit"}
        </span>
      </div>
    </li>
  );
}

function StatCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "success" | "muted";
}) {
  const cls =
    tone === "success"
      ? "border-[#cdebd6] bg-[#eaf7ee] text-[#15803d]"
      : "border-border bg-card text-muted-foreground";
  return (
    <div className={`rounded-[22px] border p-5 ${cls}`}>
      <p className="text-[11px] font-bold uppercase tracking-[0.14em]">{label}</p>
      <p className="mt-1 text-2xl font-black">{value}</p>
    </div>
  );
}
