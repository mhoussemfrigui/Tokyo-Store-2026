"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, Loader2, Lock, Sparkles } from "lucide-react";

import { AdminCallout } from "@/components/admin/_components/filter-bar";

import {
  getEmbeddingStatusAction,
  runEmbeddingBackfillBatchAction,
  type EmbeddingStatus,
} from "@/lib/actions/embeddings";

/**
 * « Vectorisation du catalogue » — the semantic-search backfill panel.
 *
 * CLIENT-DRIVEN: clicking « Vectoriser » loops `runEmbeddingBackfillBatchAction` (100
 * products/call → one embeddings API request per call) until nothing remains, driving
 * a live progress bar off `remaining`. Resumable + idempotent — closing the page just
 * pauses it; already-embedded products are skipped on the next run. Shows coverage
 * (X / Y produits vectorisés on the current model) and warns when no embedding
 * provider is configured.
 */

const BATCH_SIZE = 100;
/** Safety ceiling on loop iterations (100 × 2000 = 200k products). */
const MAX_ITERATIONS = 2000;

export function SemanticBackfillPanel({ canManage }: { canManage: boolean }) {
  const [status, setStatus] = useState<EmbeddingStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [runStats, setRunStats] = useState<{ embedded: number; failed: number } | null>(null);
  const runningRef = useRef(false);

  const refresh = useCallback(async () => {
    try {
      setStatus(await getEmbeddingStatusAction());
    } catch {
      setError("Impossible de lire l'état de la vectorisation.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    return () => {
      runningRef.current = false;
    };
  }, [refresh]);

  const runBackfill = useCallback(async () => {
    if (runningRef.current) return;
    runningRef.current = true;
    setRunning(true);
    setError(null);
    let embedded = 0;
    let failed = 0;
    let prevRemaining = Number.POSITIVE_INFINITY;
    try {
      for (let i = 0; i < MAX_ITERATIONS; i++) {
        if (!runningRef.current) break; // unmounted / stopped
        const res = await runEmbeddingBackfillBatchAction(BATCH_SIZE);
        if (!res.ok) {
          setError(res.message);
          break;
        }
        embedded += res.embedded;
        failed += res.failed;
        setRunStats({ embedded, failed });
        setStatus((s) =>
          s ? { ...s, needing: res.remaining, current: Math.max(0, s.totalPublished - res.remaining) } : s,
        );
        if (res.done) break;
        // Stuck-guard: a batch that embedded nothing and didn't shrink the backlog
        // (persistent provider/API failure) would loop forever — stop instead.
        if (res.embedded === 0 && res.remaining >= prevRemaining) {
          setError(
            res.errors[0] ??
              "La vectorisation n'a pas progressé (erreur du fournisseur). Réessayez plus tard.",
          );
          break;
        }
        prevRemaining = res.remaining;
      }
    } finally {
      runningRef.current = false;
      setRunning(false);
      void refresh();
    }
  }, [refresh]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 rounded-[16px] border border-border bg-card px-4 py-6 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Chargement de l&apos;état de la vectorisation…
      </div>
    );
  }
  if (!status) {
    // A failed status read must surface the error, not render a blank panel.
    return (
      <div className="flex items-start gap-2 rounded-[16px] border border-[#f3e3bd] bg-[#fff4e0] px-4 py-6 text-sm font-semibold text-[#b45309]">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" strokeWidth={2} />
        {error ?? "État de la vectorisation indisponible."}
      </div>
    );
  }

  const { totalPublished, current, needing, model, hasProvider } = status;
  const pct = totalPublished > 0 ? Math.round((current / totalPublished) * 100) : 0;
  const complete = needing === 0 && totalPublished > 0;

  return (
    <div className="space-y-4 rounded-[22px] border border-border bg-card px-4 py-4">
      <div className="flex items-start gap-3">
        <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-primary" strokeWidth={2} />
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-bold text-foreground">Vectorisation du catalogue</h3>
          <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
            Génère les vecteurs de sens des produits (nécessaires à la recherche sémantique).
            Chaque produit est vectorisé une fois ; les modifications de texte le sont
            automatiquement ensuite. Modèle : <span className="font-medium text-foreground">{model}</span>.
          </p>
        </div>
      </div>

      {!hasProvider && (
        <div className="flex items-start gap-2 rounded-[12px] border border-[#f3e3bd] bg-[#fff4e0] px-3 py-2.5">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[#b45309]" strokeWidth={2} />
          <p className="text-[11px] leading-relaxed text-[#b45309]">
            Aucun fournisseur d&apos;embeddings configuré. Activez OpenRouter ou OpenAI dans{" "}
            <span className="font-medium">Système → IA & Automation → Réglages</span>, puis choisissez
            le fournisseur et le modèle dans l&apos;onglet{" "}
            <span className="font-medium">Embeddings</span> avant de vectoriser.
          </p>
        </div>
      )}

      {/* Coverage bar. */}
      <div>
        <div className="mb-1 flex items-center justify-between text-[11px] text-muted-foreground">
          <span>
            {current.toLocaleString("fr-FR")} / {totalPublished.toLocaleString("fr-FR")} produits
            vectorisés
          </span>
          <span className="font-medium text-foreground">{pct}%</span>
        </div>
        <div
          className="h-2 w-full overflow-hidden rounded-full bg-surface"
          role="progressbar"
          aria-valuenow={pct}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="Progression de la vectorisation du catalogue"
        >
          <div
            className={`h-full rounded-full transition-all ${complete ? "bg-[#15803d]" : "bg-primary"}`}
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>

      {complete && !running && (
        <p className="flex items-center gap-1.5 text-[11px] font-medium text-[#15803d]">
          <CheckCircle2 className="h-3.5 w-3.5" strokeWidth={2} /> Catalogue entièrement vectorisé.
        </p>
      )}

      {runStats && (running || runStats.failed > 0) && (
        <p className="text-[11px] text-muted-foreground">
          {runStats.embedded.toLocaleString("fr-FR")} vectorisé
          {runStats.embedded > 1 ? "s" : ""} cette session
          {runStats.failed > 0 ? ` · ${runStats.failed} en échec` : ""}.
        </p>
      )}

      {error && <p className="text-[11px] text-destructive">{error}</p>}

      {canManage ? (
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => void runBackfill()}
            disabled={running || !hasProvider || (complete && !running)}
            className="inline-flex h-10 items-center gap-2 rounded-full bg-primary px-4 text-[14px] font-extrabold text-primary-foreground shadow-lift transition hover:bg-[#b8042a] disabled:opacity-50"
          >
            {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
            {running
              ? `Vectorisation… (${needing.toLocaleString("fr-FR")} restants)`
              : complete
                ? "Catalogue à jour"
                : needing < totalPublished
                  ? "Reprendre la vectorisation"
                  : "Vectoriser le catalogue"}
          </button>
          {running && (
            <button
              type="button"
              onClick={() => {
                runningRef.current = false;
              }}
              className="text-[11px] font-medium text-muted-foreground hover:text-foreground"
            >
              Arrêter
            </button>
          )}
        </div>
      ) : (
        <AdminCallout tone="warning" icon={Lock}>
          Lecture seule — la permission «&nbsp;gérer&nbsp;» est requise pour vectoriser.
        </AdminCallout>
      )}
    </div>
  );
}
