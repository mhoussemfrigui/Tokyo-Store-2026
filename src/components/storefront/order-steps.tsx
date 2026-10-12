import {
  CheckCircle2,
  Clock,
  CreditCard,
  Inbox,
  Package,
  RotateCcw,
  Truck,
  XCircle,
} from "lucide-react";

import type { OrderStatus } from "@/lib/order/status";
import { ORDER_STATUS_LABELS } from "@/lib/order/status";

/**
 * Customer-facing delivery timeline. The journey is METHOD-AWARE because the
 * payment moment differs between the two checkout paths:
 *  • Online / prepaid → "Payée" is one of the FIRST steps (settled upfront,
 *    which also confirms the order), so it sits right after "Reçue".
 *  • COD (cash on delivery) → payment is the LAST step (cash collected on the
 *    doorstep), so "Payée" sits after "Livrée"; the order is instead accepted
 *    by the shop via an explicit "Confirmée" step.
 * "Reçue" is reached the instant the order exists. Terminal `cancelled`/
 * `refunded` show a notice instead of the timeline.
 *
 * Server-safe + presentational (no client deps): rendered straight inside the
 * RSC order page. Completed steps fill olive.
 */
const STEPS_ONLINE = [
  { key: "received", label: "Reçue", icon: Inbox },
  { key: "paid", label: "Payée", icon: CreditCard },
  { key: "preparing", label: "En préparation", icon: Package },
  { key: "shipped", label: "Expédiée", icon: Truck },
  { key: "delivered", label: "Livrée", icon: CheckCircle2 },
] as const;

const STEPS_COD = [
  { key: "received", label: "Reçue", icon: Inbox },
  { key: "confirmed", label: "Confirmée", icon: Clock },
  { key: "preparing", label: "En préparation", icon: Package },
  { key: "shipped", label: "Expédiée", icon: Truck },
  { key: "delivered", label: "Livrée", icon: CheckCircle2 },
  { key: "paid", label: "Payée", icon: CreditCard },
] as const;

/**
 * Status (+ confirmation/payment) → timeline frontier (index of the furthest
 * reached step), per payment style.
 *
 * Online: Reçue(0) → Payée(1, status `paid`) → préparation(2) → expédiée(3) →
 * livrée(4). A still-`pending` online order hasn't paid yet → 0.
 * COD: Reçue(0) → Confirmée(1, needs `confirmed`) → préparation(2) → expédiée(3)
 * → livrée(4) → Payée(5, once `paid` — COD stamps paid_at at delivery).
 */
function frontierFor(
  status: OrderStatus,
  { confirmed, paidUpfront, paid }: { confirmed: boolean; paidUpfront: boolean; paid: boolean },
): number {
  if (status === "cancelled" || status === "refunded") return -1;
  if (paidUpfront) {
    switch (status) {
      case "pending":
        return 0;
      case "paid":
        return 1;
      case "preparing":
        return 2;
      case "shipped":
        return 3;
      case "delivered":
        return 4;
      default:
        return -1;
    }
  }
  switch (status) {
    case "pending":
    case "paid":
      return confirmed ? 1 : 0;
    case "preparing":
      return 2;
    case "shipped":
      return 3;
    case "delivered":
      return paid ? 5 : 4; // COD: "Payée" lights once cash is collected at delivery
    default:
      return -1;
  }
}

export function OrderSteps({
  status,
  confirmed = false,
  paidUpfront = false,
  paid = false,
}: {
  status: OrderStatus;
  /** Whether the order has been confirmed (order.confirmed_at != null). */
  confirmed?: boolean;
  /** Payment taken upfront (online/prepaid) vs at delivery (COD). */
  paidUpfront?: boolean;
  /** Payment settled (order.paid_at != null) — lights the COD "Payée" step. */
  paid?: boolean;
}) {
  // Terminal states don't belong on the forward journey — a cancelled or
  // refunded order shows an explicit notice instead of a half-lit stepper.
  if (status === "cancelled") {
    return (
      <div className="flex items-center gap-3 rounded-2xl border border-destructive/20 bg-destructive/5 p-5 sm:p-6">
        <XCircle className="h-5 w-5 shrink-0 text-destructive" strokeWidth={1.5} />
        <p className="font-body text-sm text-destructive">Cette commande a été annulée.</p>
      </div>
    );
  }
  if (status === "refunded") {
    return (
      <div className="flex items-center gap-3 rounded-2xl border border-amber-500/20 bg-amber-500/5 p-5 sm:p-6">
        <RotateCcw className="h-5 w-5 shrink-0 text-amber-600" strokeWidth={1.5} />
        <p className="font-body text-sm text-amber-700">
          Cette commande a été remboursée.
        </p>
      </div>
    );
  }

  const steps = paidUpfront ? STEPS_ONLINE : STEPS_COD;
  const frontier = frontierFor(status, { confirmed, paidUpfront, paid });

  return (
    <div className="rounded-2xl border border-border/30 p-6 sm:p-8">
      <p className="mb-6 font-body text-[0.6rem] uppercase tracking-[0.2em] text-foreground/50">
        Suivi de livraison
      </p>
      <div className="flex items-start justify-between">
        {steps.map((step, i) => {
          const isComplete = i <= frontier;
          const Icon = step.icon;
          return (
            <div key={step.key} className="relative flex flex-1 flex-col items-center">
              {/* Connector from the previous node — olive once both ends are reached. */}
              {i > 0 && (
                <span
                  className={`absolute right-1/2 top-4 h-px w-full ${
                    i <= frontier ? "bg-olive" : "bg-border/40"
                  }`}
                  aria-hidden
                />
              )}
              <span
                className={`relative z-10 grid h-8 w-8 place-items-center rounded-full transition-colors ${
                  isComplete
                    ? "bg-olive text-background"
                    : "bg-muted text-muted-foreground/40"
                }`}
              >
                <Icon className="h-3.5 w-3.5" strokeWidth={1.5} />
              </span>
              <span
                className={`mt-2.5 text-center font-body text-[0.55rem] tracking-wide ${
                  isComplete ? "text-foreground" : "text-muted-foreground/40"
                }`}
              >
                {step.label}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * The customer trail's events from raw `order_status_history` rows (keeps their
 * order — newest first): REAL status changes only. An operator line edit writes
 * a same-status row (`from_status = to_status`) as an admin audit marker; on the
 * customer trail it would show the current status twice, unexplained, so those
 * rows stay admin/API-only. The placement row (`from_status` null) is kept.
 */
export function customerTrailEvents(
  history: ReadonlyArray<{ from_status: string | null; to_status: string; created_at: Date }>,
): { status: string; at: string }[] {
  return history
    .filter((h) => h.from_status !== h.to_status)
    .map((h) => ({ status: h.to_status, at: h.created_at.toISOString() }));
}

/**
 * Compact dated history of the order's real status transitions
 * (`order_status_history`, newest first — build `events` with
 * `customerTrailEvents`). Complements the stepper with the actual timestamps of
 * each change — only rendered when the order has more than the initial creation
 * event.
 */
export function OrderStatusTrail({
  events,
}: {
  events: { status: string; at: string }[];
}) {
  if (events.length === 0) return null;
  return (
    <div className="rounded-2xl border border-border/30 p-6 sm:p-8">
      <p className="mb-5 font-body text-[0.6rem] uppercase tracking-[0.2em] text-foreground/50">
        Historique
      </p>
      <ol className="space-y-0">
        {events.map((e, idx) => (
          <li key={`${e.status}-${e.at}-${idx}`} className="relative flex gap-4 pb-5 last:pb-0">
            {/* Vertical rail dot — the most recent (idx 0) is the active olive node. */}
            <div className="relative flex flex-col items-center">
              <span
                className={`mt-1 h-2.5 w-2.5 shrink-0 rounded-full ${
                  idx === 0 ? "bg-olive" : "bg-border"
                }`}
              />
              {idx < events.length - 1 && (
                <span className="mt-1 w-px flex-1 bg-border/40" aria-hidden />
              )}
            </div>
            <div className="min-w-0 pb-1">
              <p
                className={`font-body text-sm ${
                  idx === 0 ? "text-foreground" : "text-muted-foreground"
                }`}
              >
                {ORDER_STATUS_LABELS[e.status as OrderStatus] ?? e.status}
              </p>
              <p className="mt-0.5 font-body text-[0.7rem] tracking-wide text-muted-foreground/60">
                {new Date(e.at).toLocaleString("fr-FR", {
                  dateStyle: "long",
                  timeStyle: "short",
                })}
              </p>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
