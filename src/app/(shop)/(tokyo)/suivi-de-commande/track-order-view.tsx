"use client";

import { useActionState } from "react";
import { Check, PackageSearch } from "lucide-react";

import { trackOrderAction } from "@/lib/actions/order";
import { ORDER_STATUS_LABELS, type OrderStatus } from "@/lib/order/status";
import { PageTop } from "@/storefront/components/storefront/page-top";
import { badge, btn, card, field, fieldLabel, panel, panelPad, rhythm } from "@/storefront/components/storefront/ui-classes";
import { minorToDinars, formatDinars } from "@/storefront/lib/price";
import { useSiteContacts, telHref } from "@/storefront/lib/site-contacts";
import { cn } from "@/storefront/lib/utils";

const STATUS_TONE: Record<OrderStatus, string> = {
  pending: badge.neutral,
  paid: badge.accent,
  preparing: badge.accent,
  shipped: badge.accent,
  delivered: badge.success,
  cancelled: "bg-destructive/10 text-destructive",
  refunded: badge.muted,
};

/** Linear happy-path steps; cancelled/refunded are shown as a status badge only. */
const STEPS: { key: OrderStatus; label: string }[] = [
  { key: "pending", label: "Reçue" },
  { key: "paid", label: "Confirmée" },
  { key: "preparing", label: "En préparation" },
  { key: "shipped", label: "Expédiée" },
  { key: "delivered", label: "Livrée" },
];

const DELIVERY_LABELS: Record<string, string> = {
  home_delivery: "Livraison à domicile",
  in_store: "Retrait en boutique",
  drive_by_pickup: "Retrait en drive",
};

export function TrackOrderView() {
  const [state, formAction, pending] = useActionState(trackOrderAction, null);
  const { phone: sitePhone } = useSiteContacts();
  const error = state && !state.ok ? state.message : undefined;
  const order = state && state.ok ? state.order : undefined;
  const stepIndex = order ? STEPS.findIndex((s) => s.key === order.status) : -1;
  const terminal = order?.status === "cancelled" || order?.status === "refunded";

  return (
    <>
      <PageTop
        crumbs={[{ label: "Accueil", to: "/" }, { label: "Suivi de commande" }]}
        title="Suivi de commande"
        meta="Entrez votre numéro de commande et le téléphone utilisé lors de l'achat pour suivre son avancement."
      />

      <div className={cn("page-container", rhythm.island)}>
        <div className="w-full pb-4">
          <div className={cn(card, "p-6 lg:p-8")}>
            <form action={formAction} className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <label htmlFor="orderNumber" className={fieldLabel}>
                    Numéro de commande
                  </label>
                  <input
                    id="orderNumber"
                    name="orderNumber"
                    type="text"
                    required
                    autoComplete="off"
                    placeholder="CMD-XXXXXX"
                    className={cn(field, "tabular-nums")}
                  />
                </div>
                <div>
                  <label htmlFor="phone" className={fieldLabel}>
                    Téléphone
                  </label>
                  <input
                    id="phone"
                    name="phone"
                    type="tel"
                    required
                    autoComplete="tel"
                    placeholder="ex : 50 059 160"
                    className={field}
                  />
                </div>
              </div>
              <button
                type="submit"
                disabled={pending}
                className={cn(btn.base, btn.lg, btn.primary, "w-full sm:w-auto")}
              >
                <PackageSearch aria-hidden className="size-4" />
                {pending ? "Recherche…" : "Suivre ma commande"}
              </button>
            </form>

            {error && (
              <p role="alert" className="mt-4 rounded-inner bg-destructive/10 px-4 py-3 text-[13px] font-medium text-destructive">
                {error}
              </p>
            )}
          </div>

          {order && (
            <section className={cn(panel, panelPad, rhythm.island)}>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-[13px] text-muted-foreground">Commande</p>
                  <p className="font-semibold text-foreground">{order.number}</p>
                </div>
                <span className={cn(badge.base, STATUS_TONE[order.status])}>
                  {ORDER_STATUS_LABELS[order.status]}
                </span>
              </div>

              {!terminal && (
                <ol className="mt-6 space-y-3">
                  {STEPS.map((s, i) => {
                    const done = i <= stepIndex;
                    const current = i === stepIndex;
                    return (
                      <li key={s.key} className="flex items-center gap-3">
                        <span
                          aria-hidden
                          className={cn(
                            "grid size-6 shrink-0 place-items-center rounded-full border text-[11px] font-bold",
                            done
                              ? "border-primary bg-primary text-primary-foreground"
                              : "border-border text-muted-foreground",
                          )}
                        >
                          {done ? <Check className="size-3.5" strokeWidth={3} /> : i + 1}
                        </span>
                        <span
                          className={cn(
                            "text-sm",
                            current ? "font-semibold text-foreground" : done ? "text-foreground" : "text-muted-foreground",
                          )}
                        >
                          {s.label}
                        </span>
                      </li>
                    );
                  })}
                </ol>
              )}

              <dl className="mt-6 space-y-2 border-t border-border pt-4 text-sm">
                <div className="flex items-center justify-between gap-3">
                  <dt className="text-muted-foreground">Mode de réception</dt>
                  <dd className="font-medium text-foreground">
                    {DELIVERY_LABELS[order.deliveryMethod] ?? order.deliveryMethod}
                  </dd>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <dt className="text-muted-foreground">Total</dt>
                  <dd className="font-bold tabular-nums text-foreground">
                    {formatDinars(minorToDinars(order.totalCents))}
                  </dd>
                </div>
              </dl>

              <p className="mt-4 text-[12px] text-muted-foreground">
                Une question sur votre commande ? Notre service client est joignable au{" "}
                <a href={telHref(sitePhone)} className="font-medium text-primary hover:underline">
                  {sitePhone}
                </a>
                .
              </p>
            </section>
          )}
        </div>
      </div>
    </>
  );
}
