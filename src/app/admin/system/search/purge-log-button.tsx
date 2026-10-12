"use client";

import { useState } from "react";
import { Loader2, Trash2 } from "lucide-react";

import { ConfirmDeleteModal } from "@/components/admin/confirm-delete-modal";
import { purgeSearchLogAction } from "@/lib/actions/search-maintenance";

/**
 * Admin maintenance control for the `search_log` table. Triggers
 * `purgeSearchLogAction` with the given retention window (defaults 90 days; the
 * Purge tab passes the configured `search.purge_months × 30` so the manual purge
 * matches the automatic one exactly). Mirrors the audit-log purge button on
 * /admin/system/audit.
 */
export function PurgeSearchLogButton({
  retentionDays = 90,
}: {
  retentionDays?: number;
}) {
  // Clamp to [7, 730] to match `searchService.purgeOlderThan` AND the workflow's
  // Zod `.min(7).max(730)` — the workflow REJECTS out-of-range (it doesn't clamp),
  // so flooring-only would surface a generic "Validation échouée" if a window > 730
  // ever reached here. Today purge_months ≤ 24 ⇒ ≤ 720, so this is belt-and-braces.
  const RETENTION_DAYS = Math.min(730, Math.max(7, Math.round(retentionDays)));
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
        className="inline-flex h-9 items-center gap-2 rounded-full border-[1.5px] border-destructive/40 bg-destructive/5 px-4 text-xs font-bold text-destructive transition hover:bg-destructive/10 disabled:opacity-60"
      >
        {pending ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <Trash2 className="h-3.5 w-3.5" />
        )}
        Purger {">"} {RETENTION_DAYS} jours
      </button>

      {confirming && (
        <ConfirmDeleteModal
          title={`Purger les recherches de plus de ${RETENTION_DAYS} jours ?`}
          description={`Cette action est irréversible. Toutes les lignes du journal de recherche antérieures à ${RETENTION_DAYS} jours seront définitivement supprimées. Les analytiques restent disponibles sur la fenêtre conservée.`}
          confirmLabel="Purger"
          onCancel={() => setConfirming(false)}
          onConfirm={async () => {
            setPending(true);
            try {
              const res = await purgeSearchLogAction({ olderThanDays: RETENTION_DAYS });
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
