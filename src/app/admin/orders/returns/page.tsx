import type { Metadata } from "next";
import Link from "next/link";
import { Undo2, RotateCcw, PackageCheck, TrendingDown, MessageSquare } from "lucide-react";

import { requirePermission } from "@/lib/auth/session";
import { returnService } from "@/modules/order/returns.service";
import { countPendingReturns, listReturnCommentsSince } from "@/modules/order/queries";
import { RETURN_REASON_LABELS, type ReturnReasonCode } from "@/modules/order/returns.schema";
import { NativeSelect } from "@/components/ui/select-field";
import { AdminNote } from "@/components/admin/_components/filter-bar";
import { ReturnsSubnav } from "./returns-subnav";

export const metadata: Metadata = { title: "Retours — Après vente (SAV)" };

const WINDOWS = [
  { value: "7", label: "7 jours" },
  { value: "30", label: "30 jours" },
  { value: "90", label: "90 jours" },
  { value: "365", label: "12 mois" },
] as const;

const STATUS_LABEL: Record<string, string> = {
  pending: "En attente",
  received: "Reçu",
  rejected: "Rejeté",
};
const STATUS_CLS: Record<string, string> = {
  pending: "border-[#f3e3bd] bg-[#fff4e0] text-[#b45309]",
  received: "border-[#cdebd6] bg-[#eaf7ee] text-[#15803d]",
  rejected: "border-[#efe9e3] bg-[#f6f2ed] text-[#5b5d62]",
};

const reasonLabel = (code: string | null) =>
  code ? (RETURN_REASON_LABELS[code as ReturnReasonCode] ?? code) : "Non précisé";

/** Operator comments listed at most (the section header states the window total). */
const COMMENTS_SHOWN = 200;

/**
 * Retours (SAV) hub — Commandes-level dashboard for the returns subsystem. Shows
 * aggregate KPIs over a configurable window (return rate vs orders, restock
 * rate, by-status + by-reason breakdown, most-returned products), the pending
 * to-do count (ALL pending returns, whatever their age), the recent returns list
 * and the operator comments of the window (queried server-side, not filtered
 * out of the recent list) for later SAV study. Read-only; gated by `returns:view`.
 */
export default async function ReturnsHubPage({
  searchParams,
}: {
  searchParams: Promise<{ window?: string }>;
}) {
  await requirePermission("returns", "view");
  const sp = await searchParams;
  const sinceDays = WINDOWS.some((w) => w.value === sp.window) ? Number(sp.window) : 30;

  // Scoped to the AFTER-SALE flow (kind='after_sale') so « Retour d'expédition »
  // (RTO) bounces never inflate the SAV return rate / top-returned products —
  // those live on their own sub-tab (/admin/orders/returns/expedition).
  const [stats, recent, pendingCount, comments] = await Promise.all([
    returnService.dashboardStats(sinceDays, "after_sale").catch(() => null),
    returnService.listAllWithOrder(100, "after_sale").catch(() => []),
    // The to-do KPI is NOT windowed — an old unprocessed return still needs work.
    countPendingReturns("after_sale").catch(() => null),
    listReturnCommentsSince(sinceDays, { limit: COMMENTS_SHOWN, kind: "after_sale" }).catch(() => ({
      total: 0,
      items: [],
    })),
  ]);

  const withComment = comments.items;

  return (
    <div className="space-y-6">
      <ReturnsSubnav />
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-[22px] border border-border bg-card px-5 py-4">
        <AdminNote className="max-w-3xl">
          Statistiques des retours après vente, taux de réintégration et commentaires opérateurs
          agrégés pour l&apos;analyse SAV. Déclarez un retour depuis la page d&apos;une commande.
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

      {!stats ? (
        <p className="rounded-2xl border border-dashed border-border bg-surface/40 p-6 text-center text-sm text-muted-foreground">
          Statistiques indisponibles.
        </p>
      ) : (
        <>
          {/* KPI cards */}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Kpi icon={<Undo2 className="h-4 w-4" />} label="Retours" value={String(stats.total)} hint={`sur ${sinceDays} j`} />
            <Kpi
              icon={<TrendingDown className="h-4 w-4" />}
              label="Taux de retour"
              value={`${stats.returnRatePct}%`}
              hint={`${stats.returnedOrdersInWindow} / ${stats.ordersInWindow} commandes retournées`}
            />
            <Kpi
              icon={<PackageCheck className="h-4 w-4" />}
              label="Taux de réintégration"
              value={`${stats.restockRatePct}%`}
              hint="reçus / (reçus + rejetés)"
            />
            <Kpi
              icon={<RotateCcw className="h-4 w-4" />}
              label="En attente"
              value={String(pendingCount ?? stats.byStatus.pending ?? 0)}
              hint={pendingCount != null ? "à traiter — toutes périodes" : `à traiter (sur ${sinceDays} j)`}
            />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            {/* By reason */}
            <section className="rounded-[28px] border border-border bg-card p-4">
              <h2 className="mb-3 text-[18px] font-black tracking-[-0.02em] text-foreground">Par motif</h2>
              {stats.byReason.length === 0 ? (
                <p className="text-sm text-muted-foreground">Aucun retour sur la période.</p>
              ) : (
                <ul className="space-y-2">
                  {stats.byReason.map((r) => {
                    const pct = stats.total > 0 ? Math.round((r.count / stats.total) * 100) : 0;
                    return (
                      <li key={r.code ?? "none"} className="text-sm">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-foreground">{reasonLabel(r.code)}</span>
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

            {/* Top returned products */}
            <section className="rounded-[28px] border border-border bg-card p-4">
              <h2 className="mb-3 text-[18px] font-black tracking-[-0.02em] text-foreground">Produits les plus retournés</h2>
              {stats.topProducts.length === 0 ? (
                <p className="text-sm text-muted-foreground">Aucun produit retourné sur la période.</p>
              ) : (
                <ol className="space-y-1.5">
                  {stats.topProducts.map((p, idx) => (
                    <li key={`${p.name}-${idx}`} className="flex items-center justify-between gap-2 text-sm">
                      <span className="min-w-0 truncate text-foreground">
                        <span className="mr-1.5 text-muted-foreground">{idx + 1}.</span>
                        {p.name}
                      </span>
                      <span className="shrink-0 tabular-nums text-muted-foreground">{p.units} u.</span>
                    </li>
                  ))}
                </ol>
              )}
            </section>
          </div>

          {/* Recent returns */}
          <section className="rounded-[28px] border border-border bg-card p-4">
            <h2 className="mb-3 text-[18px] font-black tracking-[-0.02em] text-foreground">Retours récents</h2>
            {recent.length === 0 ? (
              <p className="text-sm text-muted-foreground">Aucun retour enregistré.</p>
            ) : (
              <div className="overflow-x-auto rounded-[16px] border border-border">
                <table className="w-full min-w-[40rem] text-sm">
                  <thead className="bg-[#fbf9f8] text-left text-[12px] font-bold uppercase tracking-[0.06em] text-[#8a857f]">
                    <tr>
                      <th className="px-4 py-3">Commande</th>
                      <th className="px-4 py-3">Statut</th>
                      <th className="px-4 py-3">Motif</th>
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
                        <td className="px-4 py-3 text-muted-foreground">{reasonLabel(r.reasonCode)}</td>
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

          {/* Aggregated operator comments */}
          {withComment.length > 0 && (
            <section className="rounded-[28px] border border-border bg-card p-4">
              <h2 className="mb-3 inline-flex items-center gap-2 text-[18px] font-black tracking-[-0.02em] text-foreground">
                <MessageSquare className="h-4 w-4" /> Commentaires opérateurs ({comments.total}) — sur{" "}
                {sinceDays} j
              </h2>
              {comments.total > withComment.length && (
                <p className="-mt-1 mb-3 text-[11px] text-muted-foreground">
                  Seuls les {withComment.length} plus récents de la période sont affichés.
                </p>
              )}
              <ul className="space-y-2.5">
                {withComment.map((r) => (
                  <li key={r.id} className="rounded-[14px] border border-border bg-[#fbf9f8] p-3 text-sm">
                    <div className="mb-1 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                      <Link href={`/admin/orders/${r.orderId}`} className="font-mono font-semibold text-primary hover:underline">
                        {r.orderNumber}
                      </Link>
                      <span>· {reasonLabel(r.reasonCode)}</span>
                      <span>· {r.createdAt.toLocaleDateString("fr-FR")}</span>
                    </div>
                    <p className="text-foreground">{r.comment}</p>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
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
