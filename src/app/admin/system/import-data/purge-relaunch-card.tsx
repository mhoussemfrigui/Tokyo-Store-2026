"use client";

import { useState, useTransition } from "react";
import { AlertTriangle, Loader2, MailCheck, ShieldAlert } from "lucide-react";

import { requestDemoPurgeAction, confirmDemoPurgeAction } from "@/lib/actions/demo-purge";

const CONFIRM_PHRASE = "PURGER";

/**
 * Super-admin-only danger card: purge ALL data (content + every order + every
 * customer) then relaunch the demo. Two-step, email-confirmed:
 *   1. request → a one-time 6-digit code is emailed to the acting super-admin.
 *   2. enter the code + type PURGER → the (irreversible) purge fires in the
 *      background; the demo re-seeds + the catalogue feed re-imports.
 * Only rendered when the page resolves the viewer as a super-admin; the actions
 * re-check the `*` wildcard server-side regardless.
 */
export function PurgeRelaunchCard() {
  const [phase, setPhase] = useState<"idle" | "code-sent">("idle");
  const [code, setCode] = useState("");
  const [phrase, setPhrase] = useState("");
  const [pending, startTransition] = useTransition();
  const [feedback, setFeedback] = useState<{ kind: "ok" | "err" | "info"; msg: string } | null>(
    null,
  );

  const requestCode = () => {
    setFeedback(null);
    startTransition(async () => {
      const res = await requestDemoPurgeAction();
      if (res.ok) {
        setPhase("code-sent");
        setFeedback({ kind: "info", msg: res.message ?? "Code envoyé." });
      } else {
        setFeedback({ kind: "err", msg: res.message });
      }
    });
  };

  const confirmPurge = () => {
    setFeedback(null);
    startTransition(async () => {
      const res = await confirmDemoPurgeAction({ code: code.trim() });
      if (res.ok) {
        setPhase("idle");
        setCode("");
        setPhrase("");
        setFeedback({ kind: "ok", msg: res.message ?? "Purge lancée." });
      } else {
        setFeedback({ kind: "err", msg: res.message });
      }
    });
  };

  const canConfirm = /^\d{6}$/.test(code.trim()) && phrase.trim().toUpperCase() === CONFIRM_PHRASE;

  return (
    <div className="rounded-[28px] border border-destructive/40 bg-destructive/5 p-6">
      <div className="flex items-start gap-3">
        <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-destructive" strokeWidth={2} />
        <div className="min-w-0 flex-1">
          <h2 className="text-[18px] font-black tracking-[-0.02em] text-foreground">
            Réinitialiser : purger TOUT puis relancer la démo
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            <strong>Action irréversible, réservée au super-admin.</strong> Supprime
            définitivement tout le contenu (produits, catégories, marques,
            bannières, promos, navigation, FAQ, attributs), <strong>toutes les
            commandes</strong> et <strong>tous les clients</strong>, puis recharge
            la démo. Les comptes admin/staff, les rôles et les réglages
            paiement/système sont préservés. Une vérification par code email est
            requise.
          </p>

          {feedback && (
            <p
              className={`mt-3 inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium ${
                feedback.kind === "ok"
                  ? "bg-[#eaf7ee] text-[#15803d]"
                  : feedback.kind === "err"
                    ? "bg-destructive/10 text-destructive"
                    : "bg-primary/10 text-primary"
              }`}
            >
              {feedback.kind === "info" && <MailCheck className="h-3.5 w-3.5" />}
              {feedback.kind === "err" && <AlertTriangle className="h-3.5 w-3.5" />}
              {feedback.msg}
            </p>
          )}

          {phase === "idle" ? (
            <button
              type="button"
              onClick={requestCode}
              disabled={pending}
              className="mt-4 inline-flex h-10 items-center gap-2 rounded-full border-[1.5px] border-destructive/50 bg-destructive/10 px-5 text-sm font-bold text-destructive transition hover:bg-destructive/15 disabled:opacity-60"
            >
              {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <MailCheck className="h-4 w-4" />}
              Demander le code de confirmation
            </button>
          ) : (
            <div className="mt-4 space-y-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="flex flex-col gap-1">
                  <span className="text-[12px] font-bold text-foreground">
                    Code reçu par email (6 chiffres)
                  </span>
                  <input
                    value={code}
                    onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                    inputMode="numeric"
                    autoComplete="off"
                    placeholder="••••••"
                    className="h-10 rounded-[12px] border-[1.5px] border-input bg-[#fbf9f8] px-3 text-sm tracking-[0.4em] text-foreground transition focus:border-foreground focus:bg-white focus:outline-none"
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-[12px] font-bold text-foreground">
                    Tapez « {CONFIRM_PHRASE} » pour confirmer
                  </span>
                  <input
                    value={phrase}
                    onChange={(e) => setPhrase(e.target.value)}
                    autoComplete="off"
                    placeholder={CONFIRM_PHRASE}
                    className="h-10 rounded-[12px] border-[1.5px] border-input bg-[#fbf9f8] px-3 text-sm text-foreground transition focus:border-foreground focus:bg-white focus:outline-none"
                  />
                </label>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={confirmPurge}
                  disabled={pending || !canConfirm}
                  className="inline-flex h-10 items-center gap-2 rounded-full bg-destructive px-5 text-[14px] font-extrabold text-destructive-foreground transition hover:opacity-90 disabled:opacity-50"
                >
                  {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldAlert className="h-4 w-4" />}
                  Confirmer la purge + relancer la démo
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setPhase("idle");
                    setCode("");
                    setPhrase("");
                    setFeedback(null);
                  }}
                  disabled={pending}
                  className="inline-flex h-10 items-center rounded-full border-[1.5px] border-input bg-card px-4 text-sm font-medium text-muted-foreground hover:text-foreground disabled:opacity-60"
                >
                  Annuler
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
