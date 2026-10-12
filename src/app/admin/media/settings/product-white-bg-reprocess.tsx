"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2, Sparkles } from "lucide-react";

import {
  getReprocessJobStatusAction,
  startProductWhiteBgReprocessAction,
  type ReprocessJobStatus,
} from "@/lib/actions/data-jobs";

/**
 * Détourage des produits EXISTANTS — admin-triggered background job.
 *
 * The `product_white_bg` toggle above only détoure FUTURE uploads. This card
 * fires a one-off job (`startProductWhiteBgReprocessAction`) that re-processes
 * the existing product packshots, then polls `getReprocessJobStatusAction`
 * every ~2s to drive a live progress bar. Fully independent of the settings
 * form's submit — its own action, its own single-flight gate.
 */

const POLL_MS = 2000;

type Phase = "idle" | "confirm" | "running" | "done" | "failed" | "busy";

export function ProductWhiteBgReprocess() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [status, setStatus] = useState<ReprocessJobStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Clear the poll loop on unmount.
  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  function stopPolling() {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }

  function startPolling(jobId: string) {
    stopPolling();
    timerRef.current = setInterval(async () => {
      try {
        const next = await getReprocessJobStatusAction(jobId);
        if (!next) return;
        setStatus(next);
        if (next.status === "completed") {
          stopPolling();
          setPhase("done");
        } else if (next.status === "failed") {
          stopPolling();
          setError(next.error ?? "Le job a échoué.");
          setPhase("failed");
        }
      } catch {
        // Transient poll error — keep polling; a terminal state will resolve it.
      }
    }, POLL_MS);
  }

  async function onConfirm() {
    setError(null);
    setStatus(null);
    setPhase("running");
    try {
      const res = await startProductWhiteBgReprocessAction();
      if (!res.ok) {
        setError(res.message);
        setPhase("busy");
        return;
      }
      startPolling(res.jobId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erreur inattendue.");
      setPhase("failed");
    }
  }

  const isActive = phase === "running";
  const total = status?.total ?? 0;
  const processed = status?.processed ?? 0;
  const pct = total > 0 ? Math.min(100, Math.round((processed / total) * 100)) : 0;
  const changed = status?.result?.mediaCreated ?? 0;
  const skipped = status?.result?.skipped ?? 0;
  const failed = status?.result?.mediaFailed ?? 0;

  return (
    <section className="space-y-3 rounded-[28px] border border-border bg-card p-5">
      <div>
        <h3 className="text-[18px] font-black text-foreground">
          Détourage des produits existants
        </h3>
        <p className="mt-1 text-[13px] text-muted-foreground">
          Le détourage automatique ci-dessus ne s&apos;applique qu&apos;aux nouveaux téléversements.
          Lancez cette tâche pour rendre transparents les fonds UNIS (blanc, noir, gris…) des
          packshots produits déjà en ligne. Elle s&apos;exécute en arrière-plan ; les visuels sans
          fond uni détourable (photos d&apos;ambiance, fond texturé) sont laissés intacts. Cette même
          tâche peut aussi s&apos;exécuter automatiquement (cron quotidien) — voir{" "}
          <a href="/admin/system/jobs" className="font-medium text-primary hover:underline">
            Système → Tâches planifiées
          </a>{" "}
          (tâche « Détourage des images produits »).
        </p>
      </div>

      {phase === "idle" && (
        <button
          type="button"
          onClick={() => setPhase("confirm")}
          className="inline-flex h-11 items-center gap-2 rounded-full border-[1.5px] border-input bg-card px-4 text-[14px] font-bold text-foreground transition hover:bg-surface"
        >
          <Sparkles className="h-4 w-4" />
          Re-traiter les images produits
        </button>
      )}

      {phase === "confirm" && (
        <div className="space-y-3 rounded-[14px] border border-border bg-[#fbf9f8] p-3">
          <p className="text-xs font-medium text-foreground">
            Rendre transparents les fonds unis (blanc, noir, gris…) de tous les produits existants ?
          </p>
          <p className="text-xs text-muted-foreground">
            Opération irréversible : les anciennes versions des images traitées sont supprimées
            (l&apos;original conservé, s&apos;il existe, est gardé). Les images déjà détourées
            sont ignorées.
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={onConfirm}
              className="inline-flex h-9 items-center gap-2 rounded-full bg-primary px-4 text-[13px] font-extrabold text-primary-foreground transition hover:bg-[#b8042a]"
            >
              Confirmer
            </button>
            <button
              type="button"
              onClick={() => setPhase("idle")}
              className="inline-flex h-9 items-center rounded-full border-[1.5px] border-input bg-card px-4 text-[13px] font-bold text-foreground transition hover:bg-surface"
            >
              Annuler
            </button>
          </div>
        </div>
      )}

      {phase === "running" && (
        <div className="space-y-2" role="status" aria-live="polite">
          <div className="flex items-center gap-2 text-xs font-medium text-foreground">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            {total > 0
              ? `Traitement en cours… ${processed}/${total}`
              : "Préparation du job…"}
          </div>
          <div
            className="h-2 w-full overflow-hidden rounded-full bg-background"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={pct}
          >
            <div
              className="h-full rounded-full bg-primary transition-[width] duration-300"
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>
      )}

      {phase === "done" && (
        <div className="rounded-[14px] border border-primary/40 bg-primary/5 p-3 text-xs text-primary">
          Terminé : {changed} image{changed === 1 ? "" : "s"} détourée
          {changed === 1 ? "" : "s"}, {skipped} ignorée{skipped === 1 ? "" : "s"}
          {failed > 0 ? `, ${failed} en échec` : ""}.
          <button
            type="button"
            onClick={() => {
              setStatus(null);
              setPhase("idle");
            }}
            className="ml-2 font-semibold underline-offset-2 hover:underline"
          >
            Relancer
          </button>
        </div>
      )}

      {phase === "busy" && (
        <div className="rounded-[14px] border border-border bg-[#fbf9f8] p-3 text-xs text-muted-foreground">
          {error ?? "Une opération est déjà en cours."}
          <button
            type="button"
            onClick={() => {
              setError(null);
              setPhase("idle");
            }}
            className="ml-2 font-semibold text-foreground underline-offset-2 hover:underline"
          >
            Fermer
          </button>
        </div>
      )}

      {phase === "failed" && (
        <div className="rounded-[14px] border border-destructive/40 bg-destructive/5 p-3 text-xs text-destructive">
          Échec : {error ?? "erreur inconnue"}.
          <button
            type="button"
            onClick={() => {
              setError(null);
              setStatus(null);
              setPhase("idle");
            }}
            className="ml-2 font-semibold underline-offset-2 hover:underline"
          >
            Réessayer
          </button>
        </div>
      )}

      {/* `isActive` keeps the affordance disabled while a poll loop is live. */}
      {isActive && (
        <p className="text-[10px] text-muted-foreground">
          Vous pouvez quitter cette page : le traitement continue en arrière-plan.
        </p>
      )}
    </section>
  );
}
