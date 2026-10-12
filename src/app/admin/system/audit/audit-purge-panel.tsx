"use client";

import Link from "next/link";
import { useState } from "react";
import { AlertTriangle, CheckCircle2, Clock, Database, ExternalLink, Loader2, Lock, Trash2 } from "lucide-react";

import { AdminCallout } from "@/components/admin/_components/filter-bar";

import { ConfirmDeleteModal } from "@/components/admin/confirm-delete-modal";
import { purgeOldAuditEntriesAction } from "@/lib/actions/admin";

export type AuditPurgeState = {
  retentionMonths: number;
  /** retention_purge kill-switch (Tâches planifiées). */
  jobEnabled: boolean;
  lastRunLabel: string | null;
  lastRunStatus: string | null;
  lastRunSummary: string | null;
};

/**
 * "Purge" tab of the audit control center — mirrors the Recherche Purge panel:
 * read-only echo of the configured retention window, the retention_purge cron
 * status + last run, and a manual purge that uses the SAME configured window.
 */
export function AuditPurgePanel({
  retentionMonths,
  jobEnabled,
  lastRunLabel,
  lastRunStatus,
  lastRunSummary,
  canManage,
}: AuditPurgeState & { canManage: boolean }) {
  const windowDays = retentionMonths * 30;
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-[18px] font-black tracking-[-0.02em] text-foreground">
          Conservation &amp; purge du journal d&apos;audit
        </h2>
        <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
          Le journal d&apos;audit est en ajout seul. Pour éviter une croissance
          illimitée, une purge automatique quotidienne supprime les entrées plus
          anciennes que la fenêtre configurée.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3 rounded-[16px] border border-border bg-card px-4 py-3.5">
        <Database className="h-4 w-4 shrink-0 text-muted-foreground" strokeWidth={2} />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-foreground">
            Fenêtre de conservation : {retentionMonths} mois
          </p>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            ≈ {windowDays} jours. Modifiable dans l&apos;onglet{" "}
            <span className="font-medium text-foreground">Réglages</span>.
          </p>
        </div>
      </div>

      <div
        className={`flex flex-wrap items-start gap-3 rounded-[16px] border px-4 py-3.5 ${
          jobEnabled ? "border-[#cdebd6] bg-[#eaf7ee]" : "border-[#f3e3bd] bg-[#fff4e0]"
        }`}
      >
        {jobEnabled ? (
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-[#15803d]" strokeWidth={2} />
        ) : (
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[#b45309]" strokeWidth={2} />
        )}
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-foreground">
            {jobEnabled ? "Purge automatique active" : "Purge automatique en pause"}
          </p>
          <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
            {jobEnabled
              ? "La tâche planifiée « retention_purge » s'exécute quotidiennement."
              : "La tâche planifiée « retention_purge » est désactivée : le journal n'est plus purgé automatiquement."}{" "}
            <Link
              href="/admin/system/jobs"
              className="inline-flex items-center gap-1 font-medium text-primary hover:underline"
            >
              Gérer dans Tâches planifiées
              <ExternalLink className="h-3 w-3" strokeWidth={2} />
            </Link>
          </p>
          {lastRunLabel && (
            <p className="mt-1.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <Clock className="h-3 w-3" strokeWidth={2} />
              Dernière exécution : {lastRunLabel}
              {lastRunStatus ? ` · ${lastRunStatus}` : ""}
              {lastRunSummary ? ` — ${lastRunSummary}` : ""}
            </p>
          )}
        </div>
      </div>

      <div className="rounded-[16px] border border-border bg-card px-4 py-3.5">
        <p className="text-sm font-semibold text-foreground">Purge manuelle</p>
        <p className="mb-3 mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
          Lance immédiatement une purge selon la fenêtre configurée ({retentionMonths} mois).
        </p>
        {canManage ? (
          <PurgeButton windowDays={windowDays} />
        ) : (
          <AdminCallout tone="warning" icon={Lock}>
            Lecture seule — la permission « gérer » est requise pour purger.
          </AdminCallout>
        )}
      </div>
    </div>
  );
}

function PurgeButton({ windowDays }: { windowDays: number }) {
  // The workflow re-validates [30, 3650]; clamp here too so a tiny configured
  // window (1 month = 30d) is always a valid argument.
  const DAYS = Math.min(3650, Math.max(30, Math.round(windowDays)));
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<{ kind: "ok" | "err"; msg: string } | null>(null);

  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      {feedback && (
        <p className={`text-xs ${feedback.kind === "ok" ? "text-primary" : "text-destructive"}`}>
          {feedback.msg}
        </p>
      )}
      <button
        type="button"
        onClick={() => setConfirming(true)}
        disabled={pending}
        className="inline-flex h-9 items-center gap-2 rounded-full border border-destructive/40 bg-destructive/5 px-4 text-xs font-semibold text-destructive transition hover:bg-destructive/10 disabled:opacity-60"
      >
        {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
        Purger {">"} {DAYS} jours
      </button>

      {confirming && (
        <ConfirmDeleteModal
          title={`Purger les entrées de plus de ${DAYS} jours ?`}
          description={`Cette action est irréversible. Toutes les entrées du journal d'audit antérieures à ${DAYS} jours seront définitivement supprimées.`}
          confirmLabel="Purger"
          onCancel={() => setConfirming(false)}
          onConfirm={async () => {
            setPending(true);
            try {
              const res = await purgeOldAuditEntriesAction({ olderThanDays: DAYS });
              if (res.ok) {
                setFeedback({ kind: "ok", msg: res.message ?? "Purge effectuée." });
                setConfirming(false);
                return null;
              }
              setFeedback({ kind: "err", msg: res.message });
              return res.message;
            } finally {
              setPending(false);
            }
          }}
        />
      )}
    </div>
  );
}
