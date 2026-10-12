import Link from "next/link";
import { History } from "lucide-react";

import { formatMoneyExact } from "@/lib/price";
import { formatStoreDate } from "@/lib/time/store-tz";
import type { UserOrderSummary } from "@/modules/order/queries";

/**
 * « Historique client » insight on the order detail — a compact read-only summary
 * of this customer's order history (this order included), so the operator knows at
 * a glance whether they're serving a first-time buyer or a repeat/VIP. Matches by
 * account (user_id) + the guest checkouts under the same email, exactly like the
 * customer 360. Rendered only when there is history to show (canManage-gated).
 */
export function CustomerHistoryCard({
  summary,
  customerHref,
  currentOrderId,
}: {
  summary: UserOrderSummary;
  /** Deep link to the customer 360 when the order is linked to an account. */
  customerHref: string | null;
  currentOrderId: string;
}) {
  // Nothing useful to say for a lone first order (orderCount ≤ 1 and no spend).
  if (summary.orderCount <= 1 && summary.paidSpendCents === 0) return null;
  const repeat = summary.orderCount > 1;

  return (
    <section className="rounded-[28px] border border-border bg-card p-4">
      <h2 className="mb-2 inline-flex items-center gap-2 text-[18px] font-black tracking-[-0.02em] text-foreground">
        <History className="h-4 w-4" /> Historique client
        {repeat && (
          <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-semibold uppercase text-primary">
            Client fidèle
          </span>
        )}
      </h2>
      <dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
        <Cell label="Commandes" value={String(summary.orderCount)} />
        <Cell label="Total payé" value={formatMoneyExact(summary.paidSpendCents)} />
        <Cell
          label="1re commande"
          value={summary.firstOrderAt ? formatStoreDate(summary.firstOrderAt, { dateStyle: "short" }) : "—"}
        />
        <Cell
          label="Dernière"
          value={summary.lastOrderAt ? formatStoreDate(summary.lastOrderAt, { dateStyle: "short" }) : "—"}
        />
      </dl>
      {customerHref && (
        <Link
          href={customerHref}
          className="mt-3 inline-block text-[11px] text-primary underline-offset-2 hover:underline"
        >
          Voir la fiche client →
        </Link>
      )}
      {/* Marker so the count is understood as inclusive of the order on screen. */}
      <p className="sr-only">Commande courante : {currentOrderId}</p>
    </section>
  );
}

function Cell({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="font-semibold text-foreground">{value}</dd>
    </div>
  );
}
