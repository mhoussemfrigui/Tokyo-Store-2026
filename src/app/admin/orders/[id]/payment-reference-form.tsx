"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { CreditCard, Loader2 } from "lucide-react";

import { setOrderPaymentReferenceAction } from "@/lib/actions/order";
import { SelectField } from "@/components/ui/select-field";

/**
 * Inline admin form to fill in `payment_method` + `payment_reference` on
 * an order. Used for wire transfers and other off-gateway settlements that
 * the webhook subscribers don't see.
 *
 * The form stays expanded when the order already has a reference so the
 * admin can correct typos; it collapses to a single button otherwise.
 *
 * `methodLocked` (order past « En attente » and not yet settled): the method
 * select is disabled and left unchanged — only the reference is editable,
 * mirroring the server lock in setOrderPaymentReferenceWorkflow (switching the
 * method of an unsettled order in fulfilment would strand `paid_at`).
 */
export function PaymentReferenceForm({
  orderId,
  currentMethod,
  currentReference,
  methodLocked = false,
}: {
  orderId: string;
  currentMethod: string | null;
  currentReference: string | null;
  methodLocked?: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(currentReference !== null);
  const [method, setMethod] = useState(currentMethod ?? "");
  const [reference, setReference] = useState(currentReference ?? "");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const submit = () => {
    setError(null);
    setSuccess(null);
    if (reference.trim().length === 0) {
      setError("Référence requise.");
      return;
    }
    startTransition(async () => {
      const res = await setOrderPaymentReferenceAction({
        orderId,
        paymentMethod: methodLocked ? null : method.trim() || null,
        paymentReference: reference.trim(),
      });
      if (!res.ok) {
        setError(res.message);
      } else {
        setSuccess(res.message ?? "Enregistré.");
        router.refresh();
      }
    });
  };

  if (!open) {
    return (
      <section className="rounded-[28px] border border-border bg-card p-5">
        <h2 className="mb-2 inline-flex items-center gap-2 text-[18px] font-black tracking-[-0.02em] text-foreground">
          <CreditCard className="h-4 w-4" /> Paiement
        </h2>
        <p className="text-sm text-muted-foreground">
          Aucune référence enregistrée. Pour les virements ou paiements
          hors-passerelle, renseignez-la manuellement.
        </p>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="mt-3 inline-flex h-9 items-center gap-1.5 rounded-full border-[1.5px] border-input bg-card px-3 text-[13px] font-bold text-foreground transition hover:bg-surface"
        >
          Saisir une référence
        </button>
      </section>
    );
  }

  return (
    <section className="rounded-[28px] border border-border bg-card p-5">
      <h2 className="mb-3 inline-flex items-center gap-2 text-[18px] font-black tracking-[-0.02em] text-foreground">
        <CreditCard className="h-4 w-4" /> Paiement
      </h2>
      <div className="grid gap-3">
        {/* Constrained to the payment_method enum values — a free-text method
            (e.g. "chèque") would hit the enum column and 500 (22P02). "" keeps
            the current method unchanged. `card_stripe` (no live provider) and
            `konnect` (removed) are intentionally omitted — they aren't
            operator-selectable offline settlement methods. */}
        <SelectField
          label="Méthode"
          value={method}
          onChange={setMethod}
          disabled={methodLocked}
          helper={
            methodLocked
              ? "Verrouillée : commande en cours de traitement et non encore réglée — la méthode ne se change qu'en attente ou une fois le paiement encaissé."
              : undefined
          }
          options={[
            { value: "", label: "— Inchangée" },
            { value: "cash", label: "Espèces" },
            { value: "bank_transfer", label: "Virement" },
            { value: "cod", label: "Paiement à la livraison" },
            { value: "flouci", label: "Flouci" },
            { value: "clictopay", label: "ClicToPay" },
          ]}
        />
        <label className="flex flex-col gap-1">
          <span className="text-[13px] font-bold text-foreground">
            Référence *
          </span>
          <input
            value={reference}
            onChange={(e) => setReference(e.target.value)}
            placeholder="ex: VIR-2026-0042"
            className="h-11 rounded-[14px] border-[1.5px] border-input bg-[#fbf9f8] px-3 text-[15px] focus:border-foreground focus:bg-white focus:outline-none"
          />
        </label>
        <div className="flex items-center gap-2 pt-1">
          <button
            type="button"
            disabled={pending}
            onClick={submit}
            className="inline-flex h-11 items-center gap-2 rounded-full bg-primary px-5 text-[14px] font-extrabold text-primary-foreground hover:bg-[#b8042a] disabled:opacity-60"
          >
            {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Enregistrer
          </button>
          {currentReference === null && (
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="inline-flex h-11 items-center rounded-full border-[1.5px] border-input bg-card px-4 text-[14px] font-bold text-foreground hover:bg-surface"
            >
              Annuler
            </button>
          )}
        </div>
        {error && <p className="text-xs text-destructive">{error}</p>}
        {success && <p className="text-xs text-primary">{success}</p>}
      </div>
    </section>
  );
}
