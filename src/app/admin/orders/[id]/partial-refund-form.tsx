"use client";

import { useActionState, useState } from "react";
import { Loader2, ReceiptText } from "lucide-react";

import { refundOrderAction } from "@/lib/actions/order";
import { dinarsToMinor, formatMoneyExact, minorToDinars } from "@/lib/price";
import { ConfirmDeleteModal } from "@/components/admin/confirm-delete-modal";

type State =
  | { ok: true; message?: string; totalRefundedCents?: number }
  | { ok: false; error: string; message: string }
  | null;

const formatTnd = formatMoneyExact;

/**
 * Issue a partial refund. The card sums prior refunds server-side and
 * shows "X TND sur Y TND" so admins know how much is still refundable.
 *
 * The form action wraps the order-id + amount-in-TND inputs and calls
 * `refundOrderAction`. We accept the amount in TND for ergonomics and
 * convert to integer minor units (millimes) before submitting.
 *
 * Refunds are FINAL (positive-only, no correcting entry). An amount that
 * reaches the remaining balance fully refunds the order — restock of the
 * unshipped units and the coupon slot freed — so that submit is intercepted and
 * needs an explicit confirmation spelling this out (a typo like 1000 instead of
 * 100 TND can't be undone afterwards).
 */
export function PartialRefundForm({
  orderId,
  totalCents,
  alreadyRefundedCents,
}: {
  orderId: string;
  totalCents: number;
  alreadyRefundedCents: number;
}) {
  const [state, action, isPending] = useActionState<State, FormData>(
    async (_prev, formData) => {
      const amountTnd = Number(formData.get("amountTnd"));
      if (!Number.isFinite(amountTnd) || amountTnd <= 0) {
        return { ok: false, error: "validation", message: "Montant invalide." };
      }
      const reason = String(formData.get("reason") ?? "").trim();
      const res = await refundOrderAction({
        orderId,
        amountCents: dinarsToMinor(amountTnd),
        reason: reason || undefined,
      });
      return res as State;
    },
    null,
  );

  const remainingCents = Math.max(0, totalCents - alreadyRefundedCents);
  const refundedDisplay = formatTnd(alreadyRefundedCents);
  const totalDisplay = formatTnd(totalCents);
  // The submitted form, held while the « remboursement intégral » confirm is open.
  const [confirmFull, setConfirmFull] = useState<FormData | null>(null);

  return (
    <section className="rounded-[28px] border border-border bg-card p-4">
      <h2 className="mb-2 inline-flex items-center gap-2 text-[18px] font-black tracking-[-0.02em] text-foreground">
        <ReceiptText className="h-4 w-4" /> Remboursement partiel
      </h2>
      <p className="mb-3 text-[12px] text-muted-foreground">
        Remboursé : <span className="font-semibold text-foreground">{refundedDisplay}</span>{" "}
        sur {totalDisplay}
      </p>

      {remainingCents <= 0 ? (
        <p className="rounded-[14px] border border-dashed border-border bg-surface/40 p-3 text-[11px] text-muted-foreground">
          Commande déjà remboursée intégralement.
        </p>
      ) : (
        <form
          action={action}
          onSubmit={(e) => {
            // A refund reaching the remaining balance fully refunds the order —
            // hold the submit (preventDefault cancels the form action) until confirmed.
            const fd = new FormData(e.currentTarget);
            const amountTnd = Number(fd.get("amountTnd"));
            if (Number.isFinite(amountTnd) && amountTnd > 0 && dinarsToMinor(amountTnd) >= remainingCents) {
              e.preventDefault();
              setConfirmFull(fd);
            }
          }}
          className="space-y-2"
        >
          <label className="block text-[13px] font-bold text-foreground">
            Montant (TND)
            <input
              name="amountTnd"
              type="number"
              min={0}
              max={minorToDinars(remainingCents)}
              step="0.001"
              required
              placeholder={minorToDinars(remainingCents).toFixed(3)}
              className="mt-1 h-11 w-full rounded-[14px] border-[1.5px] border-input bg-[#fbf9f8] px-3 text-[15px] focus:border-foreground focus:bg-white focus:outline-none"
            />
          </label>
          <label className="block text-[13px] font-bold text-foreground">
            Raison (optionnel)
            <textarea
              name="reason"
              rows={2}
              placeholder="Article endommagé, geste commercial…"
              className="mt-1 w-full rounded-[14px] border-[1.5px] border-input bg-[#fbf9f8] p-2 text-sm focus:border-foreground focus:bg-white focus:outline-none"
            />
          </label>

          <button
            type="submit"
            disabled={isPending}
            className="inline-flex h-11 items-center gap-2 rounded-full bg-primary px-5 text-[14px] font-extrabold text-primary-foreground hover:bg-[#b8042a] disabled:opacity-60"
          >
            {isPending && <Loader2 className="h-3 w-3 animate-spin" />}
            Émettre remboursement
          </button>
          {state && !state.ok && (
            <p className="text-[11px] text-destructive">{state.message}</p>
          )}
          {state?.ok && <p className="text-[11px] text-primary">{state.message}</p>}
        </form>
      )}

      {confirmFull && (
        <ConfirmDeleteModal
          title="Rembourser intégralement cette commande ?"
          description={`Ce remboursement de ${formatTnd(dinarsToMinor(Number(confirmFull.get("amountTnd"))))} solde la commande (${totalDisplay}). Il est définitif : aucun remboursement ne peut être annulé ni corrigé ensuite.`}
          preview={
            <ul className="list-disc space-y-1 rounded-[14px] border border-border bg-surface/40 py-2.5 pl-7 pr-3 text-[11px] leading-relaxed text-muted-foreground">
              <li>Les unités non expédiées sont réintégrées au stock (les unités déjà expédiées reviennent par un retour).</li>
              <li>Le code promo utilisé est libéré (utilisation annulée).</li>
            </ul>
          }
          confirmLabel="Rembourser intégralement"
          icon={ReceiptText}
          onCancel={() => setConfirmFull(null)}
          onConfirm={async () => {
            // Dispatched synchronously inside the modal's transition.
            action(confirmFull);
            return null;
          }}
        />
      )}
    </section>
  );
}
