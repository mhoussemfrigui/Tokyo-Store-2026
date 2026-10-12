"use client";

import { useState, useTransition } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ChevronLeft, ChevronRight, Pin, PinOff, RotateCw, Trash2 } from "lucide-react";

import {
  pinEmailLogAction,
  deleteEmailLogAction,
  resendEmailLogAction,
} from "@/lib/actions/mailing";
import { type ActionState } from "@/lib/actions/types";
import { AdminToolbar, AdminSearch, SegmentedFilter } from "@/components/admin/_components/filter-bar";
import { ConfirmDeleteModal } from "@/components/admin/confirm-delete-modal";
import { LOG_PAGE_SIZE, LOG_PARAM, parseLogParams } from "./logs-params";

export type LogView = {
  id: string;
  toEmail: string;
  subject: string | null;
  status: string;
  category: string | null;
  flowKey: string | null;
  templateKey: string | null;
  provider: string | null;
  error: string | null;
  pinned: boolean;
  /** Account-security template (reset / verification / invitation…): its body
   *  is stored redacted, so it can't be resent — « Renvoyer » is hidden. */
  redacted: boolean;
  createdAt: string;
};

const STATUS_STYLE: Record<string, string> = {
  sent: "bg-[#eaf7ee] text-[#15803d]",
  queued: "bg-[#fff4e0] text-[#b45309]",
  pending: "bg-[#f6f2ed] text-[#5b5d62]",
  failed: "bg-[#fdecef] text-[#d40530]",
};

/**
 * Send log. Filters (status, recipient search) and pagination live in the URL
 * (`logStatus` / `logQ` / `logPage`) and are applied SERVER-side over the whole
 * log by the page — so an older send (last week's missing receipt) is findable.
 * The page hands over up to LOG_PAGE_SIZE + 1 rows: the extra one only signals
 * that a next page exists.
 */
export function LogsTab({
  logs,
  counts,
  canManage,
}: {
  logs: LogView[];
  counts: Record<string, number>;
  canManage: boolean;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [navigating, startNav] = useTransition();
  const filters = parseLogParams((k) => searchParams.get(k));
  const [q, setQ] = useState(filters.q);

  const rows = logs.slice(0, LOG_PAGE_SIZE);
  const hasMore = logs.length > LOG_PAGE_SIZE;
  const filtered = Boolean(filters.status || filters.q);

  function navigate(patch: { status?: string; q?: string; page?: number }) {
    const next = new URLSearchParams(searchParams.toString());
    const set = (key: string, value: string) => (value ? next.set(key, value) : next.delete(key));
    if (patch.status !== undefined) set(LOG_PARAM.status, patch.status);
    if (patch.q !== undefined) set(LOG_PARAM.q, patch.q.trim());
    // A filter change restarts at page 1; an explicit page move keeps the filters.
    set(LOG_PARAM.page, patch.page && patch.page > 1 ? String(patch.page) : "");
    startNav(() => router.push(`?${next.toString()}`, { scroll: false }));
  }

  return (
    <div className="space-y-3">
      <AdminToolbar>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            navigate({ q });
          }}
          className="min-w-[200px] flex-1"
        >
          <AdminSearch
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Rechercher un destinataire… (Entrée)"
            aria-label="Rechercher un destinataire"
            className="w-full"
          />
        </form>
        <SegmentedFilter
          ariaLabel="Filtrer par statut"
          value={filters.status}
          onChange={(v) => navigate({ status: v, q })}
          options={[
            { value: "", label: "Tous les statuts" },
            { value: "sent", label: "Envoyés", count: counts.sent ?? 0 },
            { value: "queued", label: "En file", count: counts.queued ?? 0 },
            { value: "pending", label: "En cours", count: counts.pending ?? 0 },
            { value: "failed", label: "Échecs", count: counts.failed ?? 0 },
          ]}
        />
      </AdminToolbar>

      {rows.length === 0 ? (
        <p className="rounded-[22px] border border-dashed border-border bg-card p-8 text-center text-[14px] text-muted-foreground">
          {filtered ? "Aucun email pour ce filtre." : "Aucun email dans le journal."}
        </p>
      ) : (
        <div
          className={`overflow-x-auto rounded-[22px] border border-border bg-card transition-opacity ${
            navigating ? "opacity-60" : ""
          }`}
        >
          <table className="w-full text-left text-xs">
            <thead className="bg-[#fbf9f8] text-[12px] font-bold uppercase tracking-[0.06em] text-[#8a857f]">
              <tr>
                <th className="px-4 py-3">Destinataire</th>
                <th className="px-4 py-3">Objet</th>
                <th className="px-4 py-3">Statut</th>
                <th className="px-4 py-3">Date</th>
                {canManage && <th className="px-4 py-3 text-right">Actions</th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((l) => (
                <LogRow key={l.id} log={l} canManage={canManage} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {(filters.page > 1 || hasMore) && (
        <div className="flex flex-wrap items-center justify-between gap-3 px-1">
          <p className="text-xs text-muted-foreground">Page {filters.page}</p>
          <div className="inline-flex items-center gap-1">
            <button
              type="button"
              disabled={filters.page <= 1 || navigating}
              onClick={() => navigate({ page: filters.page - 1 })}
              className="inline-flex h-9 items-center gap-1 rounded-full border-[1.5px] border-input bg-card px-3 text-xs font-bold text-foreground hover:bg-surface disabled:opacity-40"
            >
              <ChevronLeft className="h-3.5 w-3.5" /> Précédent
            </button>
            <button
              type="button"
              disabled={!hasMore || navigating}
              onClick={() => navigate({ page: filters.page + 1 })}
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

function LogRow({ log, canManage }: { log: LogView; canManage: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [feedback, setFeedback] = useState<{ ok: boolean; message: string } | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  // Surface every result — a refused resend (protected / incomplete row) or a
  // failed pin used to be swallowed, so the click silently did nothing.
  const run = (fn: () => Promise<ActionState>) =>
    startTransition(async () => {
      setFeedback(null);
      const res = await fn();
      setFeedback({
        ok: res.ok,
        message: res.message ?? (res.ok ? "Fait." : "L'action a échoué."),
      });
      if (res.ok) router.refresh();
    });

  return (
    <tr className="border-t border-border align-top hover:bg-[#fffbfb]">
      <td className="px-4 py-3">
        <span className="font-medium text-foreground">{log.toEmail}</span>
        {log.flowKey && <span className="block text-[10px] text-muted-foreground">{log.flowKey}</span>}
      </td>
      <td className="px-4 py-3 text-muted-foreground">
        <span className="line-clamp-1 max-w-[260px]">{log.subject ?? "—"}</span>
        {log.error && <span className="block text-[10px] text-destructive">{log.error}</span>}
      </td>
      <td className="px-4 py-3">
        <span
          className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-bold ${
            STATUS_STYLE[log.status] ?? "bg-[#f6f2ed] text-[#5b5d62]"
          }`}
        >
          {log.status}
        </span>
      </td>
      <td className="px-4 py-3 text-muted-foreground">
        {new Date(log.createdAt).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" })}
      </td>
      {canManage && (
      <td className="px-4 py-3">
        <div className="flex items-center justify-end gap-1">
          <button
            type="button"
            disabled={pending}
            title={log.pinned ? "Désépingler" : "Épingler"}
            onClick={() => run(() => pinEmailLogAction({ id: log.id, pinned: !log.pinned }))}
            className="inline-flex h-7 w-7 items-center justify-center rounded-full hover:bg-surface disabled:opacity-50"
          >
            {log.pinned ? <PinOff className="h-3.5 w-3.5" /> : <Pin className="h-3.5 w-3.5" />}
          </button>
          {log.status === "failed" && !log.redacted && (
            <button
              type="button"
              disabled={pending}
              title="Renvoyer"
              onClick={() => run(() => resendEmailLogAction({ id: log.id }))}
              className="inline-flex h-7 w-7 items-center justify-center rounded-full hover:bg-surface disabled:opacity-50"
            >
              <RotateCw className="h-3.5 w-3.5" />
            </button>
          )}
          <button
            type="button"
            disabled={pending}
            title="Supprimer du journal"
            onClick={() => setConfirmingDelete(true)}
            className="inline-flex h-7 w-7 items-center justify-center rounded-full text-destructive hover:bg-destructive/10 disabled:opacity-50"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
        {feedback && (
          <p
            role="status"
            className={`mt-1 text-right text-[10px] ${feedback.ok ? "text-[#15803d]" : "text-destructive"}`}
          >
            {feedback.message}
          </p>
        )}
        {confirmingDelete && (
          <ConfirmDeleteModal
            title="Supprimer cette entrée du journal ?"
            description={`L'envoi à ${log.toEmail} disparaîtra du journal des emails. L'email lui-même n'est pas affecté.`}
            onCancel={() => setConfirmingDelete(false)}
            onConfirm={async () => {
              const res = await deleteEmailLogAction({ id: log.id });
              if (!res.ok) return res.message;
              router.refresh();
              return null;
            }}
          />
        )}
      </td>
      )}
    </tr>
  );
}
