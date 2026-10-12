"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { CheckCircle2, CircleDollarSign, Loader2 } from "lucide-react";

import { setOrderPaymentStatusAction } from "@/lib/actions/order";
import { formatMoneyExact } from "@/lib/price";
import { PAYMENT_STATE_LABELS, type PaymentState } from "@/lib/order/payment-status";

/**
 * « Paiement manuel » — set the order's payment state (Non payée / Partiellement
 * payée / Payée) directly. Rendered on the order detail ONLY when the
 * `orders.manual_payment_enabled` setting is ON (the action re-checks it). Marking
 * « Payée » settles the order like a real payment (revenue); « Non
 * payée » / a downgrade reverses that. « Partiellement payée » records the amount
 * received (a deposit) without fully settling.
 */
export function PaymentStatusForm({
  orderId,
  currentState,
  receivedCents,
  dueCents,
  decimals,
}: {
  orderId: string;
  currentState: PaymentState;
  receivedCents: number;
  dueCents: number;
  /** Store price decimals, for the partial-amount ⇄ minor-units conversion. */
  decimals: number;
}) {
  const router = useRouter();
  const [state, setState] = useState<PaymentState>(currentState);
  // Partial amount shown in MAJOR units (what the operator types). Seed from the
  // current received amount when the order is already partial.
  const [amount, setAmount] = useState<string>(
    currentState === "partial" ? (receivedCents / 10 ** decimals).toString() : "",
  );
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const dirty =
    state !== currentState ||
    (state === "partial" &&
      Math.round((parseFloat(amount) || 0) * 10 ** decimals) !== receivedCents);

  const submit = () => {
    setError(null);
    setSuccess(null);
    let amountCents: number | undefined;
    if (state === "partial") {
      const major = parseFloat(amount);
      if (!Number.isFinite(major) || major <= 0) {
        setError("Saisissez le montant reçu (supérieur à 0).");
        return;
      }
      amountCents = Math.round(major * 10 ** decimals);
      if (amountCents >= dueCents) {
        setError(
          `Le montant partiel doit être inférieur au total dû (${formatMoneyExact(dueCents)}). Pour un paiement complet, choisissez « Payée ».`,
        );
        return;
      }
    }
    startTransition(async () => {
      const res = await setOrderPaymentStatusAction({ orderId, state, amountCents });
      if (!res.ok) {
        setError(res.message ?? "Erreur.");
        return;
      }
      setSuccess(res.message ?? "Paiement mis à jour.");
      router.refresh();
    });
  };

  return (
    <section className="rounded-[28px] border border-border bg-card p-5">
      <h2 className="mb-1 flex items-center gap-2 text-[18px] font-black tracking-[-0.02em] text-foreground">
        <CircleDollarSign className="h-4 w-4 text-primary" strokeWidth={2} />
        Paiement (manuel)
      </h2>
      <p className="mb-3 text-[12px] text-muted-foreground">
        Reçu : <span className="font-semibold text-foreground">{formatMoneyExact(receivedCents)}</span> /{" "}
        {formatMoneyExact(dueCents)}
        {currentState === "partial" && dueCents - receivedCents > 0 && (
          <> · Reste dû : <span className="font-semibold text-[#b45309]">{formatMoneyExact(dueCents - receivedCents)}</span></>
        )}
      </p>

      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
        {(["unpaid", "partial", "paid"] as PaymentState[]).map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setState(s)}
            aria-pressed={state === s}
            className={`inline-flex h-10 items-center justify-center gap-1.5 rounded-full px-4 text-sm font-semibold transition ${
              state === s
                ? s === "paid"
                  ? "bg-[#15803d] text-white"
                  : s === "partial"
                    ? "bg-[#b45309] text-white"
                    : "bg-foreground text-background"
                : "border-[1.5px] border-input bg-card text-muted-foreground hover:text-foreground"
            }`}
          >
            {s === "paid" && state === s && <CheckCircle2 className="h-4 w-4" />}
            {PAYMENT_STATE_LABELS[s]}
          </button>
        ))}
      </div>

      {state === "partial" && (
        <label className="mt-3 block">
          <span className="text-[13px] font-bold text-foreground">
            Montant reçu
          </span>
          <input
            value={amount}
            onChange={(e) => setAmount(e.target.value.replace(/[^\d.,]/g, "").replace(",", "."))}
            inputMode="decimal"
            placeholder="Ex. 200"
            className="mt-1 h-11 w-full rounded-[14px] border-[1.5px] border-input bg-[#fbf9f8] px-3 text-[15px] focus:border-foreground focus:bg-white focus:outline-none"
          />
          <span className="mt-1 block text-[10px] text-muted-foreground">
            Total dû : {formatMoneyExact(dueCents)}. Le solde restera à percevoir.
          </span>
        </label>
      )}

      {error && (
        <p className="mt-3 rounded-[14px] border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          {error}
        </p>
      )}
      {success && (
        <p className="mt-3 rounded-[14px] border border-primary/30 bg-primary/5 px-3 py-2 text-xs text-primary">
          {success}
        </p>
      )}

      <button
        type="button"
        disabled={pending || !dirty}
        onClick={submit}
        className="mt-4 inline-flex h-11 items-center gap-2 rounded-full bg-primary px-5 text-[14px] font-extrabold text-primary-foreground transition hover:bg-[#b8042a] disabled:opacity-50"
      >
        {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <CircleDollarSign className="h-4 w-4" />}
        Enregistrer le paiement
      </button>
      <p className="mt-2 text-[11px] text-muted-foreground">
        « Payée » enregistre le règlement (chiffre d&apos;affaires) comme un paiement réel ; l&apos;annuler le reverse.
      </p>
    </section>
  );
}
