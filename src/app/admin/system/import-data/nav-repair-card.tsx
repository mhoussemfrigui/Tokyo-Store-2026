"use client";

import { useState, useTransition } from "react";
import { AlertTriangle, CheckCircle2, Loader2, Wrench } from "lucide-react";

import { repairNavigationAction } from "@/lib/actions/nav-builder";

/**
 * Maintenance card: repair the navigation after a content import (the UI twin of
 * `scripts/patch-nav-fix.ts`). Idempotent — de-duplicates the top nav / «
 * Explorer la maison » / footer, drops the stale « /aide » link and ensures the
 * « Carrières » footer links. One click, with a confirm; the
 * action re-checks `navigation:update` server-side. Only rendered when the page
 * resolves the viewer as allowed to edit navigation.
 */
export function NavRepairCard() {
  const [pending, startTransition] = useTransition();
  const [feedback, setFeedback] = useState<{ kind: "ok" | "err"; msg: string } | null>(null);

  const run = () => {
    if (pending) return;
    if (
      !window.confirm(
        "Réparer la navigation ?\n\nSupprime les éléments de menu dupliqués (en-tête, « Explorer la maison », pied de page), retire l'ancien lien « /aide » et ajoute « Carrières » au pied de page. L'opération est sûre et ré-exécutable.",
      )
    ) {
      return;
    }
    setFeedback(null);
    startTransition(async () => {
      const res = await repairNavigationAction();
      setFeedback(res.ok ? { kind: "ok", msg: res.message } : { kind: "err", msg: res.message });
    });
  };

  return (
    <div className="rounded-[28px] border border-[#f3e3bd] bg-[#fff4e0] p-6">
      <div className="flex items-start gap-3">
        <Wrench className="mt-0.5 h-5 w-5 shrink-0 text-[#b45309]" strokeWidth={2} />
        <div className="min-w-0 flex-1">
          <h2 className="text-[18px] font-black tracking-[-0.02em] text-foreground">
            Réparer la navigation
          </h2>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            À lancer si le menu du haut, l&apos;index « Explorer la maison » ou le pied de
            page apparaissent <strong>en double</strong> après un import. Supprime les
            doublons, retire l&apos;ancien lien « Centre d&apos;aide » (/aide) et ajoute
            « Carrières » au pied de page. Opération sûre et
            idempotente — vous pouvez la relancer sans risque.
          </p>

          {feedback && (
            <p
              className={`mt-3 inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium ${
                feedback.kind === "ok"
                  ? "bg-[#eaf7ee] text-[#15803d]"
                  : "bg-destructive/10 text-destructive"
              }`}
            >
              {feedback.kind === "ok" ? (
                <CheckCircle2 className="h-3.5 w-3.5" />
              ) : (
                <AlertTriangle className="h-3.5 w-3.5" />
              )}
              {feedback.msg}
            </p>
          )}

          <button
            type="button"
            onClick={run}
            disabled={pending}
            className="mt-4 inline-flex h-10 items-center gap-2 rounded-full border-[1.5px] border-[#f3e3bd] bg-[#fff4e0] px-5 text-sm font-bold text-[#b45309] transition hover:bg-[#ffedcc] disabled:opacity-60"
          >
            {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wrench className="h-4 w-4" />}
            Réparer la navigation
          </button>
        </div>
      </div>
    </div>
  );
}
