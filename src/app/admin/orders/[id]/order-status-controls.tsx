"use client";

import { useEffect, useState } from "react";
import { useRefreshAction } from "@/hooks/use-refresh-action";
import {
  ArrowRight,
  Ban,
  CheckCircle2,
  Loader2,
  PackageCheck,
  RotateCcw,
  Truck,
  Wallet,
} from "lucide-react";

import { confirmOrderAction, transitionOrderStatusAction } from "@/lib/actions/order";
import { ConfirmDeleteModal } from "@/components/admin/confirm-delete-modal";
import {
  isUpfrontPaidMethod,
  orderTransitionsFor,
  orderStatusActionLabelFor,
} from "@/lib/order/status";

type Status =
  | "pending"
  | "paid"
  | "preparing"
  | "shipped"
  | "delivered"
  | "cancelled"
  | "refunded";

const ICON: Record<Status, React.ComponentType<{ className?: string; strokeWidth?: number }>> = {
  pending: ArrowRight,
  paid: Wallet,
  preparing: PackageCheck,
  shipped: Truck,
  delivered: PackageCheck,
  cancelled: Ban,
  refunded: RotateCcw,
};

/**
 * Constructive vs destructive transitions. Destructive actions (cancel,
 * refund) get a quieter visual treatment + a confirm modal so an admin
 * can't accidentally cancel a paid order by tapping the wrong button on
 * a list.
 */
const DESTRUCTIVE: Set<Status> = new Set(["cancelled", "refunded"]);

const CONSTRUCTIVE_TONE: Record<string, string> = {
  paid: "bg-primary text-primary-foreground hover:bg-[#b8042a]",
  preparing: "bg-primary text-primary-foreground hover:bg-[#b8042a]",
  shipped: "bg-primary text-primary-foreground hover:bg-[#b8042a]",
  delivered: "bg-[#15803d] text-white hover:brightness-110",
};

const DESTRUCTIVE_PROMPT: Record<string, { title: string; description: string; label: string }> = {
  cancelled: {
    title: "Annuler cette commande ?",
    description:
      "Le client est notifié. Les unités suivies non expédiées sont réintégrées au stock. L'historique reste consultable depuis l'audit.",
    label: "Annuler la commande",
  },
  // Shown instead of the above when the order is already PAID: cancelling restocks +
  // reverses promotions but does NOT return the money already collected —
  // that must be done with a remboursement. Prevents a « paid → cancelled » that
  // silently keeps the customer's cash with no refund-ledger trace.
  cancelled_paid: {
    title: "Annuler une commande DÉJÀ PAYÉE ?",
    description:
      "Cette commande a déjà été encaissée. L'annulation réintègre le stock et annule les promotions, mais NE REMBOURSE PAS le montant déjà perçu — aucun remboursement n'est enregistré. Pour rendre l'argent au client, utilisez le formulaire de remboursement. Le client est notifié.",
    label: "Annuler sans rembourser",
  },
  refunded: {
    title: "Marquer la commande « Remboursée » ?",
    description:
      "Le remboursement intégral est déjà enregistré dans le journal des remboursements ; cette action fait passer le STATUT de la commande à « Remboursée ». (Le remboursement réel auprès du prestataire de paiement se fait séparément.)",
    label: "Marquer comme remboursée",
  },
};

export function OrderStatusControls({
  orderId,
  currentStatus,
  paymentMethod,
  deliveryMethod,
  confirmed,
  fullyRefunded,
  isPaid,
}: {
  orderId: string;
  currentStatus: Status;
  /** Drives the COD-vs-online transition graph (COD has no upfront "paid" gate). */
  paymentMethod: string | null;
  /** Drives the pickup-vs-home transition graph: a pickup (in-store/drive) order has
   *  NO shipping leg, so it never offers « Marquer expédiée » and « delivered » reads
   *  « retirée ». */
  deliveryMethod: string | null;
  /** Order already confirmed (confirmed_at set). Hides the "Confirmer" CTA. */
  confirmed: boolean;
  /** A FULL refund is already on the ledger. The `→ refunded` transition refuses
   *  without one, so the button is hidden until then (a hint points to the
   *  Remboursement form instead of offering a guaranteed-to-fail action). */
  fullyRefunded: boolean;
  /** Money already collected (paid_at set). Escalates the CANCEL confirmation to warn
   *  that cancelling does NOT refund — the collected amount needs a remboursement. */
  isPaid: boolean;
}) {
  // useRefreshAction owns the pending flag + a re-entrancy guard (a second click
  // while pending is IGNORED) and refreshes OUTSIDE a transition — fixing the
  // React-19 stuck-spinner + double-fire that produced « Transition non autorisée :
  // delivered → delivered ».
  const { pending, run, router } = useRefreshAction();
  const [err, setErr] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<Status | null>(null);
  // Post-transition LOCK. `useRefreshAction` resets its own busy flag the moment
  // the action resolves, but `router.refresh()` is fire-and-forget: for a short
  // window the DB already advanced while this component still renders the OLD
  // `currentStatus` (and its OLD buttons). A click in that window fires a now-
  // illegal transition (« Transition non autorisée : preparing → preparing ») —
  // an error only a manual refresh clears. So after a SUCCESSFUL transition we
  // keep the buttons disabled until the page actually reflects the new status
  // (the `currentStatus` prop changes) — then clear the lock. A safety timeout
  // clears it even if a refresh silently no-ops, so the controls can't stick.
  const [awaitingRefresh, setAwaitingRefresh] = useState(false);
  useEffect(() => {
    // The new status landed (router.refresh committed) → unlock.
    setAwaitingRefresh(false);
  }, [currentStatus]);
  useEffect(() => {
    if (!awaitingRefresh) return;
    const t = setTimeout(() => setAwaitingRefresh(false), 8000);
    return () => clearTimeout(t);
  }, [awaitingRefresh]);
  const busy = pending || awaitingRefresh;
  const graph = orderTransitionsFor(currentStatus, paymentMethod, deliveryMethod);
  // The `→ refunded` transition requires a full refund on the ledger, so only
  // offer it once one exists — otherwise it's a guaranteed failure.
  const refundNeedsLedger = graph.includes("refunded") && !fullyRefunded;
  const next = refundNeedsLedger ? graph.filter((s) => s !== "refunded") : graph;

  // COD orders need an explicit operator confirmation (online orders auto-confirm
  // on payment). Only meaningful while the order is still `pending` + unconfirmed.
  const showConfirm =
    !confirmed && currentStatus === "pending" && !isUpfrontPaidMethod(paymentMethod);

  const submit = (s: Status) => {
    setErr(null);
    run(async () => {
      const res = await transitionOrderStatusAction(orderId, s);
      if (!res.ok) {
        setErr(res.message);
        return false; // no refresh on failure
      }
      // Hold the controls until the refreshed page shows the NEW status, so a
      // second click can't fire a stale transition before the UI catches up.
      setAwaitingRefresh(true);
    });
  };

  const submitConfirm = () => {
    setErr(null);
    run(async () => {
      const res = await confirmOrderAction(orderId);
      if (!res.ok) {
        setErr(res.message);
        return false;
      }
    });
  };

  // Hint shown when the only remaining "action" would be to mark the order
  // refunded but no full refund is recorded yet — point to the Remboursement form
  // instead of a dead-end button.
  const refundHint = refundNeedsLedger ? (
    <p className="mt-3 rounded-[14px] border border-border bg-surface/40 px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
      Pour marquer la commande « Remboursée », enregistrez d&apos;abord le remboursement
      intégral via le formulaire <strong>Remboursement</strong> ci-dessous.
    </p>
  ) : null;

  if (next.length === 0) {
    return (
      <section className="rounded-[28px] border border-border bg-card p-5">
        <h2 className="mb-2 text-[18px] font-black tracking-[-0.02em] text-foreground">Actions</h2>
        <p className="text-sm text-muted-foreground">
          {refundNeedsLedger
            ? "Aucune transition de statut directe — voir ci-dessous."
            : "Statut terminal — aucune transition disponible."}
        </p>
        {refundHint}
      </section>
    );
  }

  const constructive = next.filter((s) => !DESTRUCTIVE.has(s));
  const destructive = next.filter((s) => DESTRUCTIVE.has(s));

  return (
    <section className="rounded-[28px] border border-border bg-card p-5">
      {/* COD acceptance — the explicit confirmation step before fulfilment. */}
      {showConfirm && (
        <div className="mb-4 rounded-[22px] border border-primary/30 bg-primary/5 p-4">
          <p className="text-[13px] font-semibold text-foreground">
            Commande reçue — en attente de confirmation
          </p>
          <p className="mt-1 mb-3 text-[11px] leading-relaxed text-muted-foreground">
            Confirmez pour accepter cette commande (paiement à la livraison). Le
            client est notifié et le suivi passe à « Confirmée ».
          </p>
          <button
            type="button"
            disabled={busy}
            onClick={submitConfirm}
            className="inline-flex h-11 items-center justify-center gap-2 rounded-full bg-primary px-5 text-[14px] font-extrabold text-primary-foreground transition hover:bg-[#b8042a] disabled:opacity-60"
          >
            {busy ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <CheckCircle2 className="h-4 w-4" strokeWidth={2.2} />
            )}
            Confirmer la commande
          </button>
        </div>
      )}

      <h2 className="mb-3 text-[18px] font-black tracking-[-0.02em] text-foreground">Faire avancer</h2>

      {/* Primary CTAs — the path forward. Large, brand-coloured. */}
      <div className="flex flex-col gap-2">
        {constructive.map((s) => {
          const Icon = ICON[s];
          return (
            <button
              key={s}
              type="button"
              disabled={busy}
              onClick={() => submit(s)}
              className={`inline-flex h-11 items-center justify-center gap-2 rounded-full px-4 text-[14px] font-extrabold transition disabled:opacity-60 ${
                CONSTRUCTIVE_TONE[s] ?? "bg-foreground text-background"
              }`}
            >
              {busy ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Icon className="h-4 w-4" strokeWidth={2.2} />
              )}
              {orderStatusActionLabelFor(s, deliveryMethod)}
            </button>
          );
        })}
      </div>

      {/* Destructive actions — visually demoted (outline, smaller, muted)
          and gated by a confirm modal. */}
      {destructive.length > 0 && (
        <div className="mt-3 border-t border-border pt-3">
          <p className="mb-2 text-[11px] uppercase tracking-wider text-muted-foreground">
            Actions sensibles
          </p>
          <div className="flex flex-wrap gap-2">
            {destructive.map((s) => {
              const Icon = ICON[s];
              return (
                <button
                  key={s}
                  type="button"
                  disabled={busy}
                  onClick={() => setConfirming(s)}
                  className="inline-flex h-9 items-center gap-1.5 rounded-full border-[1.5px] border-input bg-card px-3 text-[13px] font-semibold text-muted-foreground transition hover:border-destructive/40 hover:text-destructive disabled:opacity-50"
                >
                  <Icon className="h-3.5 w-3.5" />
                  {orderStatusActionLabelFor(s, deliveryMethod)}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {err && (
        <p className="mt-3 rounded-[14px] border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          {err}
        </p>
      )}
      {refundHint}
      <p className="mt-3 text-[11px] text-muted-foreground">
        Chaque transition est enregistrée dans l&apos;historique + le journal d&apos;audit.
      </p>

      {confirming && (() => {
        // A cancel of an already-paid order gets the stronger « n'est pas remboursé »
        // warning (see cancelled_paid); everything else uses the status's own prompt.
        const promptKey = confirming === "cancelled" && isPaid ? "cancelled_paid" : confirming;
        return (
        <ConfirmDeleteModal
          title={DESTRUCTIVE_PROMPT[promptKey]?.title ?? "Confirmer ?"}
          description={DESTRUCTIVE_PROMPT[promptKey]?.description}
          confirmLabel={DESTRUCTIVE_PROMPT[promptKey]?.label ?? "Confirmer"}
          onCancel={() => setConfirming(null)}
          onConfirm={async () => {
            const res = await transitionOrderStatusAction(orderId, confirming);
            if (!res.ok) return res.message ?? "Erreur";
            router.refresh();
            return null;
          }}
        />
        );
      })()}
    </section>
  );
}
