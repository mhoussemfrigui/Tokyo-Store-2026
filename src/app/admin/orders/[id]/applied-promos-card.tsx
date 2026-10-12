import { TicketPercent, Truck } from "lucide-react";

import { formatMoneyExact } from "@/lib/price";

export type AppliedPromo = {
  label: string;
  /** true = the customer entered a coupon CODE; false = an automatic promotion. */
  isCode: boolean;
  discountCents: number;
  shippingWaivedCents: number;
  freeShipping: boolean;
};

/**
 * Read-only breakdown of the promotions applied to an order — which coupon code /
 * automatic promotion gave which discount (+ any waived shipping), so support can
 * explain a total without opening the promotions module. Reversed redemptions
 * (a full refund/cancel frees the slot) are already netted out by the caller.
 * Renders nothing when no promotion was applied.
 */
export function AppliedPromosCard({ promos }: { promos: AppliedPromo[] }) {
  if (promos.length === 0) return null;
  const totalDiscount = promos.reduce((a, p) => a + p.discountCents, 0);
  const totalShip = promos.reduce((a, p) => a + p.shippingWaivedCents, 0);

  return (
    <section className="rounded-[28px] border border-border bg-card p-4">
      <h2 className="mb-2 inline-flex items-center gap-2 text-[18px] font-black tracking-[-0.02em] text-foreground">
        <TicketPercent className="h-4 w-4" /> Promotions appliquées
      </h2>
      <ul className="space-y-2">
        {promos.map((p, i) => (
          <li key={i} className="flex flex-wrap items-center justify-between gap-2 rounded-[14px] border border-border bg-surface/40 px-3 py-2">
            <div className="min-w-0">
              <p className="flex items-center gap-2 text-[13px] font-semibold text-foreground">
                {p.isCode ? (
                  <span className="rounded bg-[#fbf9f8] px-1.5 py-0.5 font-mono text-[11px] text-primary">{p.label}</span>
                ) : (
                  <span className="truncate">{p.label}</span>
                )}
                <span className="rounded-full bg-surface px-2 py-0.5 text-[10px] font-semibold uppercase text-muted-foreground">
                  {p.isCode ? "Code" : "Auto"}
                </span>
              </p>
              {(p.freeShipping || p.shippingWaivedCents > 0) && (
                <p className="mt-0.5 inline-flex items-center gap-1 text-[11px] text-muted-foreground">
                  <Truck className="h-3 w-3" /> Livraison offerte
                  {p.shippingWaivedCents > 0 && ` (${formatMoneyExact(p.shippingWaivedCents)})`}
                </p>
              )}
            </div>
            {p.discountCents > 0 && (
              <span className="shrink-0 text-[13px] font-semibold text-[#15803d]">
                −{formatMoneyExact(p.discountCents)}
              </span>
            )}
          </li>
        ))}
      </ul>
      {(totalDiscount > 0 || totalShip > 0) && (
        <p className="mt-2 text-right text-[11px] text-muted-foreground">
          Remise totale <span className="font-semibold text-foreground">−{formatMoneyExact(totalDiscount)}</span>
          {totalShip > 0 && <> · livraison −{formatMoneyExact(totalShip)}</>}
        </p>
      )}
    </section>
  );
}
