import type { Metadata } from "next";
import Link from "next/link";
import { PackageX, RotateCcw, PackageCheck, Truck, Info } from "lucide-react";

import { requirePermission } from "@/lib/auth/session";
import { returnService } from "@/modules/order/returns.service";
import { countPendingReturns } from "@/modules/order/queries";
import { shipmentReturnReasonLabel } from "@/modules/order/returns.schema";
import { NativeSelect } from "@/components/ui/select-field";
import { AdminNote, AdminCallout } from "@/components/admin/_components/filter-bar";
import { ReturnsSubnav } from "../returns-subnav";

export const metadata: Metadata = { title: "Retours — Expédition (non livrés)" };

const WINDOWS = [
  { value: "7", label: "7 jours" },
  { value: "30", label: "30 jours" },
  { value: "90", label: "90 jours" },
  { value: "365", label: "12 mois" },
] as const;

const STATUS_LABEL: Record<string, string> = {
  pending: "En attente du colis",
  received: "Reçu — stock réintégré, commande annulée",
  rejected: "Classé (livré finalement)",
};
const STATUS_CLS: Record<string, string> = {
  pending: "border-[#f3e3bd] bg-[#fff4e0] text-[#b45309]",
  received: "border-[#cdebd6] bg-[#eaf7ee] text-[#15803d]",
  rejected: "border-[#efe9e3] bg-[#f6f2ed] text-[#5b5d62]",
};

/**
 * « Retour d'expédition » hub — the second Retours sub-tab. A shipped parcel that
 * never reached the customer (unreachable / wrong address / refused) and bounces
 * back (RTO). Declared from a shipped order's page OR by an external carrier via
 * the inbound POST /api/orders/[id]/delivery-outcome hook; confirming its receipt
 * restocks the goods AND cancels the order. Read-only dashboard; gated `returns:view`.
 */
export default async function ShipmentReturnsPage({
  searchParams,
}: {
  searchParams: Promise<{ window?: string }>;
}) {
  await requirePermission("returns", "view");
  const sp = await searchParams;
  const sinceDays = WINDOWS.some((w) => w.value === sp.window) ? Number(sp.window) : 30;

  const [stats, recent, pendingCount] = await Promise.all([
    returnService.shipmentReturnStats(sinceDays).catch(() => null),
    returnService.listShipmentReturnsWithOrder(100).catch(() => []),
    // Not windowed — an old awaited parcel still needs processing.
    countPendingReturns("shipment").catch(() => null),
  ]);

  return (
    <div className="space-y-6">
      <ReturnsSubnav />
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-[22px] border border-border bg-card px-5 py-4">
        <AdminNote className="max-w-3xl">
          Colis expédiés mais non livrés (client injoignable, adresse incorrecte, refusé…) qui
          reviennent. Confirmer la réception réintègre le stock et annule la commande. Déclarez-en
          un depuis la page d&apos;une commande expédiée.
        </AdminNote>
        <form method="GET" className="flex shrink-0 items-center gap-2">
          <NativeSelect
            name="window"
            defaultValue={String(sinceDays)}
            ariaLabel="Fenêtre d'analyse"
            options={WINDOWS.map((w) => ({ value: w.value, label: w.label }))}
            size="sm"
          />
          <button
            type="submit"
            className="inline-flex h-11 shrink-0 items-center rounded-full border-[1.5px] border-input bg-card px-4 text-[14px] font-bold text-foreground hover:bg-surface"
          >
            Voir
          </button>
        </form>
      </div>

      {/* External-livraison inbound hook note */}
      <AdminCallout tone="info" icon={Info}>
        <span>
          <strong className="text-foreground">Livraison externe</strong> — un transporteur peut
          signaler un échec de livraison via l&apos;API&nbsp;:{" "}
          <code className="rounded bg-muted px-1 py-0.5 text-[11px]">POST /api/orders/&lt;id&gt;/delivery-outcome</code>{" "}
          (portée <code className="rounded bg-muted px-1 py-0.5 text-[11px]">orders:write</code>), ce
          qui ouvre automatiquement un retour d&apos;expédition sur les lignes expédiées.
        </span>
      </AdminCallout>

      {/* KPI cards */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Kpi icon={<PackageX className="h-4 w-4" />} label="Retours d'expédition" value={String(stats?.total ?? 0)} hint={`sur ${sinceDays} j`} />
        <Kpi
          icon={<RotateCcw className="h-4 w-4" />}
          label="En attente du colis"
          value={String(pendingCount ?? stats?.byStatus.pending ?? 0)}
          hint={pendingCount != null ? "à traiter — toutes périodes" : `à traiter (sur ${sinceDays} j)`}
        />
        <Kpi
          icon={<PackageCheck className="h-4 w-4" />}
          label="Reçus (annulés)"
          value={String(stats?.byStatus.received ?? 0)}
          hint={`réintégrés + commandes annulées (sur ${sinceDays} j)`}
        />
        <Kpi
          icon={<Truck className="h-4 w-4" />}
          label="Classés (livrés)"
          value={String(stats?.byStatus.rejected ?? 0)}
          hint={`finalement livrés (sur ${sinceDays} j)`}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* By reason */}
        <section className="rounded-[28px] border border-border bg-card p-4">
          <h2 className="mb-3 text-[18px] font-black tracking-[-0.02em] text-foreground">Par motif d&apos;échec</h2>
          {!stats || stats.byReason.length === 0 ? (
            <p className="text-sm text-muted-foreground">Aucun retour d&apos;expédition sur la période.</p>
          ) : (
            <ul className="space-y-2">
              {stats.byReason.map((r) => {
                const pct = stats.total > 0 ? Math.round((r.count / stats.total) * 100) : 0;
                return (
                  <li key={r.code ?? "none"} className="text-sm">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-foreground">{shipmentReturnReasonLabel(r.code)}</span>
                      <span className="tabular-nums text-muted-foreground">
                        {r.count} · {pct}%
                      </span>
                    </div>
                    <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
                      <div className="h-full rounded-full bg-primary" style={{ width: `${pct}%` }} />
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {/* By carrier */}
        <section className="rounded-[28px] border border-border bg-card p-4">
          <h2 className="mb-3 text-[18px] font-black tracking-[-0.02em] text-foreground">Par transporteur</h2>
          {!stats || stats.byCarrier.length === 0 ? (
            <p className="text-sm text-muted-foreground">Aucun transporteur renseigné sur la période.</p>
          ) : (
            <ol className="space-y-1.5">
              {stats.byCarrier.map((c, idx) => (
                <li key={`${c.carrier}-${idx}`} className="flex items-center justify-between gap-2 text-sm">
                  <span className="min-w-0 truncate text-foreground">
                    <span className="mr-1.5 text-muted-foreground">{idx + 1}.</span>
                    {c.carrier}
                  </span>
                  <span className="shrink-0 tabular-nums text-muted-foreground">{c.count}</span>
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>

      {/* Recent shipment returns */}
      <section className="rounded-[28px] border border-border bg-card p-4">
        <h2 className="mb-3 text-[18px] font-black tracking-[-0.02em] text-foreground">Retours d&apos;expédition récents</h2>
        {recent.length === 0 ? (
          <p className="text-sm text-muted-foreground">Aucun retour d&apos;expédition enregistré.</p>
        ) : (
          <div className="overflow-x-auto rounded-[16px] border border-border">
            <table className="w-full min-w-[48rem] text-sm">
              <thead className="bg-[#fbf9f8] text-left text-[12px] font-bold uppercase tracking-[0.06em] text-[#8a857f]">
                <tr>
                  <th className="px-4 py-3">Commande</th>
                  <th className="px-4 py-3">Statut</th>
                  <th className="px-4 py-3">Motif</th>
                  <th className="px-4 py-3">Transporteur</th>
                  <th className="px-4 py-3">Tent.</th>
                  <th className="px-4 py-3">Date</th>
                </tr>
              </thead>
              <tbody>
                {recent.map((r) => (
                  <tr key={r.id} className="border-t border-border transition hover:bg-[#fffbfb]">
                    <td className="px-4 py-3">
                      <Link
                        href={`/admin/orders/${r.orderId}`}
                        className="font-mono text-[12px] font-semibold text-primary hover:underline"
                      >
                        {r.orderNumber}
                      </Link>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold ${STATUS_CLS[r.status] ?? STATUS_CLS.rejected}`}>
                        {STATUS_LABEL[r.status] ?? r.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">{shipmentReturnReasonLabel(r.reasonCode)}</td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {r.carrierName ?? "—"}
                      {r.trackingRef && <span className="block text-[10px] text-muted-foreground/70">{r.trackingRef}</span>}
                    </td>
                    <td className="px-4 py-3 tabular-nums text-muted-foreground">{r.deliveryAttempts ?? "—"}</td>
                    <td className="px-4 py-3 tabular-nums text-muted-foreground">
                      {r.createdAt.toLocaleDateString("fr-FR")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function Kpi({
  icon,
  label,
  value,
  hint,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  hint: string;
}) {
  return (
    <div className="rounded-[22px] border border-border bg-card p-4">
      <div className="inline-flex items-center gap-1.5 text-[12px] font-bold text-muted-foreground">
        {icon} {label}
      </div>
      <p className="mt-1.5 text-[28px] font-black leading-none tracking-[-0.02em] tabular-nums text-foreground">{value}</p>
      <p className="mt-1.5 text-[12px] text-muted-foreground">{hint}</p>
    </div>
  );
}
