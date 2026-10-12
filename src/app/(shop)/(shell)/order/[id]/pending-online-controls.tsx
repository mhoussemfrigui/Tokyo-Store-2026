"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, RefreshCw, XCircle } from "lucide-react";

import {
  resumeOrderPaymentAction,
  cancelMyPendingOrderAction,
} from "@/lib/actions/order";

/**
 * Customer controls for a still-unpaid ONLINE order (rendered only on
 * `/order/[id]` when `order.status === "pending"` and the method is an online
 * gateway, and only to the owner / guest-UUID holder).
 *
 *   - "Reprendre / Réessayer le paiement" re-initiates a fresh gateway session
 *     and redirects (mirrors the checkout redirect). The server first
 *     re-verifies the PREVIOUS session: if it turns out already paid (webhook
 *     not yet in), the order is settled instead and we reload it as a gateway
 *     return (confirmed page + purchase tracking); a payment signal / an
 *     unreachable gateway refuses with a message. Hidden on an amount
 *     mismatch — re-initiating can't fix a wrong amount.
 *   - "Annuler la commande" cancels the pending order (restock + loyalty
 *     reversal happen server-side via the status transition). Refused while
 *     the gateway session may still be open (payment possibly in progress).
 *
 * Both server actions re-enforce ownership + the pending guard; this component
 * only renders the buttons and handles the redirect / refresh.
 */
export function PendingOnlineControls({
  orderId,
  declined,
  allowRetry,
}: {
  orderId: string;
  declined: boolean;
  allowRetry: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState<"resume" | "cancel" | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const resume = () => {
    setErr(null);
    setBusy("resume");
    startTransition(async () => {
      const res = await resumeOrderPaymentAction(orderId);
      if (res.ok && res.redirectUrl) {
        window.location.href = res.redirectUrl;
        return;
      }
      // The previous gateway session was in fact PAID — the pre-init verify just
      // settled the order. Reload it as a gateway return so the confirmed page
      // (and the one-shot purchase tracking) replaces these controls.
      if (!res.ok && res.error === "already_paid") {
        window.location.href = `/order/${orderId}?pay=return`;
        return;
      }
      setBusy(null);
      setErr(res.message ?? "Impossible de reprendre le paiement.");
    });
  };

  const cancel = () => {
    if (
      !window.confirm(
        "Annuler cette commande ? Cette action est définitive et libère le stock réservé.",
      )
    ) {
      return;
    }
    setErr(null);
    setBusy("cancel");
    startTransition(async () => {
      const res = await cancelMyPendingOrderAction(orderId);
      setBusy(null);
      if (!res.ok) {
        setErr(res.message ?? "Impossible d'annuler la commande.");
        return;
      }
      router.refresh();
    });
  };

  return (
    <div className="mt-5">
      <div className="flex flex-wrap items-center justify-center gap-3">
        {allowRetry && (
          <button
            type="button"
            onClick={resume}
            disabled={pending}
            className="inline-flex h-11 items-center gap-2 rounded-full bg-foreground px-5 text-sm font-semibold text-background disabled:opacity-60"
          >
            {busy === "resume" ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4" />
            )}
            {declined ? "Réessayer le paiement" : "Reprendre le paiement"}
          </button>
        )}
        <button
          type="button"
          onClick={cancel}
          disabled={pending}
          className="inline-flex h-11 items-center gap-2 rounded-full border border-border bg-card px-5 text-sm font-medium text-foreground disabled:opacity-60"
        >
          {busy === "cancel" ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <XCircle className="h-4 w-4" />
          )}
          Annuler la commande
        </button>
      </div>
      {err && <p className="mt-2 text-center text-xs text-destructive">{err}</p>}
    </div>
  );
}
