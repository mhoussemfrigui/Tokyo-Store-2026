import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CheckCircle2, ShieldCheck } from "lucide-react";

import { findOrderById, listItemsForOrder } from "@/modules/order/queries";
import { isUuid } from "@/lib/utils/uuid";
import { ORDER_STATUS_LABELS, paymentMethodLabel } from "@/lib/order/status";
import { formatMoneyExact } from "@/lib/price";
import { formatDateFull } from "@/lib/format/date";

export const metadata: Metadata = {
  title: "Vérifier la commande",
  robots: { index: false, follow: false },
};

const STATUS_LABEL: Record<string, string> = ORDER_STATUS_LABELS;

const TND = formatMoneyExact;

/**
 * Public order verification page — what the QR code points at.
 *
 * Threat model:
 *   - Anyone with the UUID can read this. The ID is a UUID v7 — ~74 random
 *     bits (+ a ms creation timestamp), so brute-force isn't viable. Shoppers
 *     can hand the QR to the rider, a friend, etc.
 *   - The PUBLIC view exposes: status, total, item count, item names,
 *     destination city, and the payment METHOD (so the rider knows whether to
 *     collect cash). NOT exposed HERE: full address, phone, email, payment
 *     REFERENCE, order notes, audit trail.
 *   - BUT the QR carries the raw order UUID, which is a bearer capability
 *     beyond this page: it also opens the /order/<uuid> summary and, for a
 *     GUEST order, the /facture/<uuid> receipt (a registered order's receipt
 *     is owner / staff-gated). So never leak it (third-party tags get a
 *     scrubbed `/order/verify/:id` — src/lib/tracking/redact-url.ts). A
 *     separate QR-only verify credential is a deferred owner decision.
 *   - There is no elevated mode on this route. Any future richer payload
 *     (e.g. a warehouse portal) must sit behind a real role auth check —
 *     never a query-param toggle.
 *
 * Lifted in concept from the Medusa storefront's `/order/verify/[orderId]`
 * page (`tokyo-medusa`); adapted to Tokyo Store's color tokens and the
 * server-component data path.
 */
export default async function OrderVerifyPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  if (!isUuid(id)) notFound();

  const order = await findOrderById(id).catch(() => null);
  if (!order) {
    return (
      <main className="mx-auto max-w-md px-4 py-20 text-center">
        <ShieldCheck className="mx-auto mb-4 h-12 w-12 text-muted-foreground/20" />
        <h1 className="font-serif text-2xl">Commande introuvable</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Ce QR ne correspond à aucune commande active.
        </p>
        <Link
          href="/"
          className="mt-6 inline-flex h-10 items-center rounded-full bg-foreground px-5 text-sm font-semibold text-background"
        >
          Retour à l&apos;accueil
        </Link>
      </main>
    );
  }

  const items = await listItemsForOrder(order.id).catch(() => []);
  const itemCount = items.reduce((s, it) => s + it.quantity, 0);

  return (
    <main className="mx-auto max-w-md px-4 py-12">
      <div className="text-center tk-fade-in-up">
        <span className="mx-auto grid h-14 w-14 place-items-center rounded-full bg-olive/10 text-olive">
          <CheckCircle2 className="h-7 w-7" strokeWidth={1.2} />
        </span>
        <h1 className="mt-4 font-serif text-xl">Commande vérifiée</h1>
        <p className="mt-1 text-xs text-muted-foreground">
          Vue publique · résumé
        </p>
      </div>

      <section className="mt-8 rounded-2xl border border-border/30 p-6 md:p-8 space-y-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="font-serif text-lg">
              {order.order_number}
            </p>
            <p className="font-body text-xs text-muted-foreground">
              {formatDateFull(order.created_at)}
            </p>
          </div>
          <div className="text-right">
            <p className="font-serif text-lg">
              {TND(order.total_cents)}
            </p>
            <p className="font-body text-xs text-muted-foreground">
              {itemCount} article{itemCount !== 1 ? "s" : ""}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap gap-1.5">
          <span className="rounded-full border border-border/50 px-2.5 py-0.5 font-body text-[0.55rem] uppercase tracking-wider">
            {STATUS_LABEL[order.status] ?? order.status}
          </span>
          {order.paid_at && (
            <span className="rounded-full border border-border/50 bg-emerald-500/5 px-2.5 py-0.5 font-body text-[0.55rem] uppercase tracking-wider text-emerald-600">
              Payée
            </span>
          )}
        </div>

        {items.length > 0 && (
          <ul className="space-y-2 border-t border-border/30 pt-4 text-sm">
            {items.map((it) => (
              <li key={it.id} className="flex justify-between">
                <span className="truncate text-foreground/80">{it.product_name}</span>
                <span className="ml-2 shrink-0 text-muted-foreground">
                  ×{it.quantity}
                </span>
              </li>
            ))}
          </ul>
        )}

        <div className="border-t border-border/30 pt-4">
          <p className="text-[0.6rem] uppercase tracking-[0.15em] font-body text-muted-foreground/50">
            Destination
          </p>
          <p className="mt-1 text-sm text-foreground/80">
            {order.ship_city}
            {order.ship_country !== "TN" ? `, ${order.ship_country}` : ", Tunisie"}
          </p>
        </div>

        {/* Payment method — non-sensitive, and the rider-actionable bit: a COD
            order still to be settled shows the amount to collect; an already
            paid order (paid_at set, incl. a delivered COD) reads "déjà payée"
            so the cash hint never contradicts the "Payée" chip above. */}
        {order.payment_method && (
          <div className="border-t border-border/30 pt-4">
            <p className="text-[0.6rem] uppercase tracking-[0.15em] font-body text-muted-foreground/50">
              Paiement
            </p>
            <p className="mt-1 text-sm text-foreground/80">
              {paymentMethodLabel(order.payment_method)}
              {order.paid_at
                ? " · déjà payée"
                : order.payment_method === "cod"
                  ? // Collect the order total at delivery.
                    ` · à encaisser ${TND(order.total_cents)}`
                  : ""}
            </p>
          </div>
        )}

      </section>

      <p className="mt-6 text-center text-[11px] text-muted-foreground">
        Ce QR affiche le résumé public de la commande.
      </p>
    </main>
  );
}
