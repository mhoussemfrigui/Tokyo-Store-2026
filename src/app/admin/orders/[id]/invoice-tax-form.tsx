"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Loader2, Lock, Percent, RefreshCw } from "lucide-react";

import { setOrderInvoiceTaxAction } from "@/lib/actions/order";
import { formatMoneyExact, minorToDinars } from "@/lib/price";

/**
 * Per-order invoice TVA control. Two operator actions back the same server
 * action (`setOrderInvoiceTaxAction`):
 *
 *   • a number field (TND) to set a MANUAL override of the printed TVA, and
 *   • "Recalculer (TVA de la vente)" to drop the override and restore the TVA
 *     computed at sale time (per-line snapshots + shipping tax).
 *
 * Hidden entirely when tax is disabled — there is nothing to control. Read-only
 * once the invoice / credit note is numbered (`lockedDocument`): the printed TVA
 * is then frozen and the server workflow refuses a change (correct via an avoir).
 */
export function InvoiceTaxForm({
  orderId,
  effectiveTaxCents,
  isManual,
  taxLabel,
  disabled,
  lockedDocument,
}: {
  orderId: string;
  effectiveTaxCents: number;
  isManual: boolean;
  taxLabel: string;
  disabled: boolean;
  /** Number of the issued invoice / credit note that freezes the TVA, if any. */
  lockedDocument?: string | null;
}) {
  const router = useRouter();
  const [amount, setAmount] = useState(
    String(minorToDinars(effectiveTaxCents)),
  );
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  if (disabled) return null;

  if (lockedDocument) {
    return (
      <section className="rounded-[28px] border border-border bg-card p-4">
        <h2 className="mb-2 inline-flex items-center gap-2 text-[18px] font-black tracking-[-0.02em] text-foreground">
          <Percent className="h-4 w-4" /> {taxLabel} facture
        </h2>
        <p className="text-sm font-medium">{formatMoneyExact(effectiveTaxCents)}</p>
        <p className="mt-2 inline-flex items-start gap-1.5 text-[12px] text-muted-foreground">
          <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          Figée : document {lockedDocument} émis. Pour corriger la {taxLabel},
          émettez un avoir.
        </p>
      </section>
    );
  }

  const run = (action: () => Promise<{ ok: boolean; message?: string }>) => {
    setError(null);
    setSuccess(null);
    startTransition(async () => {
      const res = await action();
      if (!res.ok) {
        setError(res.message ?? "Échec.");
      } else {
        setSuccess(res.message ?? "Enregistré.");
        router.refresh();
      }
    });
  };

  const submitManual = () => {
    const value = Number(amount);
    if (!Number.isFinite(value) || value < 0) {
      setError("Montant de TVA invalide.");
      return;
    }
    run(() =>
      setOrderInvoiceTaxAction(orderId, { mode: "manual", amountDinars: value }),
    );
  };

  const recompute = () =>
    run(() => setOrderInvoiceTaxAction(orderId, { mode: "global" }));

  return (
    <section className="rounded-[28px] border border-border bg-card p-4">
      <h2 className="mb-2 inline-flex items-center gap-2 text-[18px] font-black tracking-[-0.02em] text-foreground">
        <Percent className="h-4 w-4" /> {taxLabel} facture
      </h2>
      <p className="mb-3 text-[12px] text-muted-foreground">
        {isManual
          ? "Montant saisi manuellement (remplace la TVA calculée)."
          : "Montant calculé. Vous pouvez le corriger manuellement ci-dessous."}
      </p>

      <div className="space-y-2">
        <label className="block text-[13px] font-bold text-foreground">
          {taxLabel} (TND)
          <div className="mt-1 flex items-center gap-2">
            <input
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              type="number"
              min={0}
              step="0.001"
              className="h-11 w-full rounded-[14px] border-[1.5px] border-input bg-[#fbf9f8] px-3 text-[15px] focus:border-foreground focus:bg-white focus:outline-none"
            />
            <button
              type="button"
              disabled={pending}
              onClick={submitManual}
              className="inline-flex h-11 shrink-0 items-center gap-2 rounded-full bg-primary px-5 text-[14px] font-extrabold text-primary-foreground hover:bg-[#b8042a] disabled:opacity-60"
            >
              {pending && <Loader2 className="h-3 w-3 animate-spin" />}
              Enregistrer
            </button>
          </div>
        </label>

        <button
          type="button"
          disabled={pending}
          onClick={recompute}
          className="inline-flex h-9 items-center gap-1.5 rounded-full border-[1.5px] border-input bg-card px-3 text-[13px] font-bold text-foreground transition hover:bg-surface disabled:opacity-60"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          Recalculer (TVA de la vente)
        </button>

        {error && <p className="text-[11px] text-destructive">{error}</p>}
        {success && <p className="text-[11px] text-primary">{success}</p>}
      </div>
    </section>
  );
}
