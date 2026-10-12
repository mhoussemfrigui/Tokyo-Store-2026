import type { Metadata } from "next";
import Link from "next/link";
import {
  Download,
  Package as PackageIcon,
  Plus,
  ShoppingCart,
  Star,
  TriangleAlert,
} from "lucide-react";

import { customerQueries } from "@/modules/customer";
import { orderService } from "@/modules/order/service";
import { productQueries } from "@/modules/catalog/product";
import { reviewService } from "@/modules/catalog/review";
import {
  getDailyOrdersSeries,
  getStatusDistribution,
} from "@/modules/order/queries";
import { getSettingsMap } from "@/modules/cms/setting/queries";
import { ORDER_STATUS_COLORS, adminStatusLabel, orderStatusLabel } from "@/lib/order/status";
import { aovCents, computeDelta, sumBy } from "@/lib/analytics/trend";
import { ANNUAL_SERIES_DAYS } from "@/lib/analytics/revenue-buckets";
import { resolveLowStockConfig } from "@/lib/inventory/low-stock";
import { DeltaBadge } from "@/components/admin/delta-badge";
import { Sparkline } from "@/components/admin/sparkline";
import { RevenueChart } from "@/components/admin/revenue-chart";
import { formatCents } from "@/lib/price";
import { STORE_TIME_ZONE } from "@/lib/time/store-tz";
import { requireAdminArea } from "@/lib/auth/session";
import { permissionSetAllows, resolveUserPermissions } from "@/lib/rbac/authorize";
import { resolveDashboardAccess } from "@/lib/rbac/dashboard-access";

export const metadata: Metadata = {
  title: "Tableau de bord",
};

const TND = formatCents;

/**
 * Split "184 250 TND" → { amount: "184 250", unit: "TND" } so the big number can
 * stay in the serif while the currency stays small + sans + muted — matching the
 * design (the thousands separators are narrow no-break spaces, so the LAST plain
 * space is reliably the one before the unit).
 */
function moneyParts(cents: number): { amount: string; unit: string } {
  const s = TND(cents);
  const i = s.lastIndexOf(" ");
  return i === -1 ? { amount: s, unit: "" } : { amount: s.slice(0, i), unit: s.slice(i + 1) };
}

export default async function AdminDashboardPage() {
  // /admin stays open to EVERY staff user (post-login landing, logo target) —
  // but each block below is gated by the grant of the module whose data it
  // shows (dashboard:view master switch + analytics/orders/customers/stock
  // view), and a hidden block's query is never run. See dashboard-access.ts.
  const live = await requireAdminArea();
  const firstName =
    (live.user.name ?? "").trim().split(/\s+/)[0] || "Administrateur";
  // React-cache()d — the admin layout already resolved it for this request.
  const perms = await resolveUserPermissions(live.user.id);
  const can = resolveDashboardAccess((m, a) => permissionSetAllows(perms, m, a));

  const [
    customerStats,
    orderStats,
    statusDist,
    recentOrders,
    lowStockCfg,
    series,
    customerSeries,
  ] = await Promise.all([
    can.customers ? customerQueries.getCustomerStats() : null,
    can.orders ? orderService.stats() : null,
    can.orders ? getStatusDistribution() : null,
    can.orders ? orderService.list({ limit: 6 }) : null,
    // The operator's configured low-stock line — the same one the alert emails
    // and the stock page's « Bas » filter use (not a hardcoded 5).
    can.stock
      ? getSettingsMap()
          .catch(() => ({}) as Record<string, string | null>)
          .then(resolveLowStockConfig)
      : null,
    // One year of daily rows powers the KPI 30-day rollups + sparklines AND the
    // revenue chart's Mois/Trimestre/Année buckets — a single aggregate query.
    // ANNUAL_SERIES_DAYS (366) reaches the 1st of month −11 so « Année » shows
    // 12 FULL calendar months. The orders KPI reads its counts too.
    can.revenue || can.orders ? getDailyOrdersSeries(ANNUAL_SERIES_DAYS) : null,
    // 60 days = a 30-day sparkline + a 30-vs-prior-30 delta for new customers.
    can.customers ? customerQueries.getDailyNewCustomersSeries(60) : null,
  ]);

  // Pending-reviews moderation nudge (reviews:view). Only the count — the panel
  // owns the list. Skipped entirely for a role without the grant.
  const pendingReviews = can.reviews ? (await reviewService.countByStatus()).pending : 0;

  // « Stock faible »: the capped rows + TRUE counts, all with the stock page's
  // own predicates (`stockStateSql`) so each number equals its link's list.
  const lowThreshold = lowStockCfg?.threshold ?? 0;
  let lowStock: Awaited<ReturnType<typeof productQueries.listLowStockProducts>> = [];
  let lowStockCount = 0;
  let outOfStockCount = 0;
  if (lowStockCfg) {
    [lowStock, lowStockCount, outOfStockCount] = await Promise.all([
      productQueries.listLowStockProducts({ threshold: lowThreshold, limit: 5 }),
      productQueries.countStockProducts("low", lowThreshold),
      productQueries.countStockProducts("out_of_stock", lowThreshold),
    ]);
  }

  // 30-day rollups with a period-over-period delta vs the PRIOR 30 days.
  // Revenue base = paid orders, NET of refunds, excluding cancelled/refunded
  // (shared `revenueOrderSql` — same as Statistiques + Commandes).
  const last30 = (series ?? []).slice(-30);
  const prev30 = (series ?? []).slice(-60, -30);
  const revenue30 = sumBy(last30, (d) => d.revenueCents);
  const revenuePrev30 = sumBy(prev30, (d) => d.revenueCents);
  const orders30 = sumBy(last30, (d) => d.count);
  const ordersPrev30 = sumBy(prev30, (d) => d.count);
  const aov30 = aovCents(revenue30, orders30);
  const aovPrev30 = aovCents(revenuePrev30, ordersPrev30);
  const revenueDelta = computeDelta(revenue30, revenuePrev30);
  const ordersDelta = computeDelta(orders30, ordersPrev30);
  const aovDelta = computeDelta(aov30, aovPrev30);

  // New customers — same 30-day rollup + delta shape, from its own daily series.
  const custLast30 = (customerSeries ?? []).slice(-30);
  const custPrev30 = (customerSeries ?? []).slice(-60, -30);
  const newCustomers30 = sumBy(custLast30, (d) => d.count);
  const newCustomersPrev30 = sumBy(custPrev30, (d) => d.count);
  const customersDelta = computeDelta(newCustomers30, newCustomersPrev30);

  // Daily sparkline windows (last 30 days).
  const revSpark = last30.map((d) => d.revenueCents);
  const ordSpark = last30.map((d) => d.count);
  const aovSpark = last30.map((d) =>
    d.count > 0 ? Math.round(d.revenueCents / d.count) : 0,
  );
  const custSpark = custLast30.map((d) => d.count);

  // Action-needed count: the SHARED « À traiter » rule (isActionableOrder /
  // actionableOrderSql) — paid, preparing AND pending COD awaiting prep (not an
  // unpaid online checkout) — the exact number the Commandes page shows.
  const needsAction = orderStats?.actionable ?? 0;
  const distTotal = (statusDist ?? []).reduce((s, r) => s + r.count, 0);

  // Lowercase weekday — it sits after "·" in the greeting subtitle.
  // Shop date (Africa/Tunis) — the UTC container would show yesterday before 01:00.
  const rawDate = new Date().toLocaleDateString("fr-FR", {
    timeZone: STORE_TIME_ZONE,
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });

  const kpis: Array<{
    label: string;
    value: string;
    /** Currency/unit shown small + sans next to the serif number (money only). */
    unit?: string;
    href: string;
    delta?: ReturnType<typeof computeDelta>;
    spark?: number[];
    sub?: string;
  }> = [];
  if (can.revenue) {
    kpis.push({
      label: "Revenu net · 30 j",
      value: moneyParts(revenue30).amount,
      unit: moneyParts(revenue30).unit,
      href: "/admin/analytics",
      delta: revenueDelta,
      spark: revSpark,
    });
  }
  if (orderStats) {
    kpis.push({
      label: "Commandes payées · 30 j",
      value: orders30.toLocaleString("fr-FR"),
      href: "/admin/orders",
      delta: ordersDelta,
      spark: ordSpark,
      sub: `${orderStats.total.toLocaleString("fr-FR")} au total`,
    });
  }
  if (customerStats) {
    kpis.push({
      label: "Nouveaux clients · 30 j",
      value: newCustomers30.toLocaleString("fr-FR"),
      href: "/admin/customers",
      delta: customersDelta,
      spark: custSpark,
      sub: `${customerStats.total.toLocaleString("fr-FR")} clients au total`,
    });
  }
  if (can.revenue) {
    kpis.push({
      label: "Panier moyen · 30 j",
      value: moneyParts(aov30).amount,
      unit: moneyParts(aov30).unit,
      href: "/admin/analytics",
      delta: aovDelta,
      spark: aovSpark,
    });
  }

  return (
    <div className="space-y-6">
      {/* Greeting + primary actions — anchored in a header card so the action row
          (Exporter / Nouveau produit) doesn't float loose on the canvas. */}
      <header className="flex flex-wrap items-center justify-between gap-4 rounded-[22px] border border-border bg-card px-5 py-4">
        <div>
          <h1 className="text-[30px] font-black leading-tight tracking-[-0.02em] text-foreground">
            Bonjour, {firstName}
          </h1>
          <p className="mt-1 text-[14px] text-muted-foreground">
            Voici l&apos;activité de votre boutique · {rawDate}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {/* Real CSV export (first 1000 orders by recency) — orders:view, like
              the /admin/orders/export route itself. */}
          {can.orders && (
            <a
              href="/admin/orders/export"
              className="inline-flex h-11 items-center gap-2 rounded-full border-[1.5px] border-input bg-card px-4 text-[14px] font-bold text-foreground transition hover:bg-surface"
            >
              <Download className="h-4 w-4" strokeWidth={2} />
              Exporter
            </a>
          )}
          {can.createProduct && (
            <Link
              href="/admin/catalog/products/new"
              className="inline-flex h-11 items-center gap-2 rounded-full bg-primary px-5 text-[14px] font-extrabold text-primary-foreground transition hover:bg-[#b8042a]"
            >
              <Plus className="h-4 w-4" strokeWidth={2.4} />
              Nouveau produit
            </Link>
          )}
        </div>
      </header>

      {/* No dashboard block granted — a neutral card, never another module's data. */}
      {!can.any && (
        <section className="rounded-[28px] border border-border bg-card p-6">
          <p className="text-[13px] text-muted-foreground">
            Votre rôle ne donne accès à aucun indicateur du tableau de bord.
            Utilisez le menu pour ouvrir les sections qui vous sont attribuées.
          </p>
        </section>
      )}

      {/* Reviews awaiting moderation — surfaced only when there's a queue, so an
          empty state never adds noise. Independent of orders access. */}
      {can.reviews && pendingReviews > 0 && (
        <Link
          href="/admin/catalog/reviews?status=pending"
          className="flex items-center justify-between gap-4 rounded-[22px] border border-primary/40 bg-primary/5 p-5 transition hover:border-primary/60"
        >
          <div className="flex items-center gap-3">
            <Star className="h-5 w-5 shrink-0 text-primary" strokeWidth={2} />
            <div>
              <p className="text-[12px] font-bold text-muted-foreground">
                Avis en attente
              </p>
              <p className="mt-0.5 text-[13px] text-foreground">
                <span className="text-[20px] font-black leading-none tabular-nums">
                  {pendingReviews.toLocaleString("fr-FR")}
                </span>{" "}
                avis à modérer
              </p>
            </div>
          </div>
          <span className="shrink-0 text-[12px] font-semibold text-primary">Modérer →</span>
        </Link>
      )}

      {/* KPI cards */}
      {kpis.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {kpis.map((k) => (
            <Link
              key={k.label}
              href={k.href}
              className="rounded-[24px] border border-border bg-card p-5 transition hover:border-primary/40"
            >
              <p className="text-[12px] font-bold text-muted-foreground">
                {k.label}
              </p>
              <div className="mt-2 flex items-end justify-between gap-3">
                <p className="text-[28px] font-black leading-none tracking-[-0.02em] text-foreground">
                  {k.value}
                  {k.unit && (
                    <span className="ml-1 font-sans text-[13px] font-medium text-muted-foreground">
                      {k.unit}
                    </span>
                  )}
                </p>
                {k.spark && (
                  <Sparkline
                    data={k.spark}
                    strokeClass="text-primary"
                    className="h-8 w-16 shrink-0"
                  />
                )}
              </div>
              <div className="mt-2 flex items-center gap-2">
                {k.delta && <DeltaBadge delta={k.delta} />}
                {k.sub && (
                  <span className="text-[11px] text-muted-foreground">{k.sub}</span>
                )}
              </div>
            </Link>
          ))}
        </div>
      )}

      {/* Revenue chart (analytics:view) + low-stock alerts (stock/products:view) */}
      {(can.revenue || can.stock) && (
        <div
          className={`grid gap-4 ${can.revenue && can.stock ? "lg:grid-cols-[1.6fr_1fr]" : ""}`}
        >
          {can.revenue && series && (
            <RevenueChart
              series={series.map((d) => ({ day: d.day, revenueCents: d.revenueCents }))}
            />
          )}

          {can.stock && (
            <section className="rounded-[22px] border border-border bg-card">
              <header className="flex items-center justify-between gap-3 border-b border-border p-4">
                <h2 className="inline-flex items-center gap-2 text-[18px] font-black text-foreground">
                  <TriangleAlert className="h-4 w-4 text-[#b45309]" /> Stock faible
                </h2>
                <div className="flex items-center gap-3">
                  {/* TRUE count (not the 5 rows below), same predicate + threshold
                      as the stock page's « Bas » filter it links to. */}
                  {lowStockCount > 0 && (
                    <span className="inline-flex items-center rounded-full bg-[#fdecef] px-2.5 py-1 text-[11px] font-bold text-[#d40530]">
                      {lowStockCount.toLocaleString("fr-FR")} alerte{lowStockCount === 1 ? "" : "s"}
                    </span>
                  )}
                  {can.stockPage && lowStockCount > 0 && (
                    <Link
                      href="/admin/catalog/stock?filter=low"
                      className="text-[12px] font-semibold text-primary transition hover:text-[var(--admin-accent-strong,var(--primary))]"
                    >
                      Tout voir →
                    </Link>
                  )}
                </div>
              </header>
              {lowThreshold <= 0 ? (
                <p className="p-6 text-[13px] text-muted-foreground">
                  Seuil « stock bas » désactivé (Catalogue → Stock → Alertes).
                </p>
              ) : lowStock.length === 0 ? (
                <p className="p-6 text-[13px] text-muted-foreground">
                  Aucune alerte — aucun produit suivi à {lowThreshold} unité
                  {lowThreshold === 1 ? "" : "s"} ou moins.
                </p>
              ) : (
                <ul className="divide-y divide-border">
                  {lowStock.map((p) => {
                    const inner = (
                      <>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[13px] font-semibold text-foreground">
                            {p.name}
                          </span>
                          <span className="block truncate text-[11px] text-muted-foreground">
                            {p.slug}
                          </span>
                        </span>
                        <span className="shrink-0 whitespace-nowrap text-right">
                          <span className="text-[14px] font-bold tabular-nums text-destructive">
                            {p.stock_qty}
                          </span>
                          <span className="ml-1 text-[11px] text-muted-foreground">
                            restant{p.stock_qty === 1 ? "" : "s"}
                          </span>
                        </span>
                      </>
                    );
                    return (
                      <li key={p.id}>
                        {/* The editor needs products:view — a stock-only role gets
                            the row without a link that would 404. */}
                        {can.productPages ? (
                          <Link
                            href={`/admin/catalog/products/${p.id}`}
                            className="flex items-center justify-between gap-3 p-4 transition hover:bg-surface/50"
                          >
                            {inner}
                          </Link>
                        ) : (
                          <div className="flex items-center justify-between gap-3 p-4">{inner}</div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
              {/* Sold-out lines (unticked, or a tracked qty 0) are « Rupture », not
                  « Bas » — counted separately with the stock page's own filter. */}
              {outOfStockCount > 0 && (
                <p className="border-t border-border px-4 py-3 text-[12px] text-muted-foreground">
                  {can.stockPage ? (
                    <Link
                      href="/admin/catalog/stock?filter=out_of_stock"
                      className="font-semibold text-destructive hover:underline"
                    >
                      {outOfStockCount.toLocaleString("fr-FR")} produit
                      {outOfStockCount === 1 ? "" : "s"} en rupture →
                    </Link>
                  ) : (
                    <span className="font-semibold text-destructive">
                      {outOfStockCount.toLocaleString("fr-FR")} produit
                      {outOfStockCount === 1 ? "" : "s"} en rupture
                    </span>
                  )}
                </p>
              )}
            </section>
          )}
        </div>
      )}

      {/* Recent orders + status breakdown (orders:view) */}
      {recentOrders && (
        <div className="grid gap-4 lg:grid-cols-[1.6fr_1fr]">
          <section className="overflow-hidden rounded-[22px] border border-border bg-card">
            <header className="flex items-center justify-between border-b border-border p-4">
              <h2 className="inline-flex items-center gap-2 text-[18px] font-black text-foreground">
                <ShoppingCart className="h-4 w-4" /> Dernières commandes
              </h2>
              <Link
                href="/admin/orders"
                className="text-[12px] font-semibold text-primary transition hover:text-[var(--admin-accent-strong,var(--primary))]"
              >
                Tout voir →
              </Link>
            </header>
            {recentOrders.items.length === 0 ? (
              <p className="p-6 text-[13px] text-muted-foreground">
                Aucune commande pour le moment.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-[13px]">
                  <thead>
                    <tr className="border-b border-border bg-[#fbf9f8] text-left text-[12px] font-bold uppercase tracking-[0.06em] text-[#8a857f]">
                      <th className="px-4 py-3 font-bold">Commande</th>
                      <th className="px-4 py-3 font-bold">Client</th>
                      <th className="hidden px-4 py-3 font-bold sm:table-cell">
                        Date
                      </th>
                      <th className="px-4 py-3 text-right font-bold">Total</th>
                      <th className="px-4 py-3 font-bold">Statut</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {recentOrders.items.map((o) => (
                      <tr key={o.id} className="transition hover:bg-[#fffbfb]">
                        <td className="px-4 py-3">
                          <Link
                            href={`/admin/orders/${o.id}`}
                            className="font-semibold text-foreground hover:text-primary"
                          >
                            {o.order_number}
                          </Link>
                        </td>
                        <td className="max-w-[12rem] truncate px-4 py-3 text-muted-foreground">
                          {o.contact_email}
                        </td>
                        <td className="hidden px-4 py-3 text-muted-foreground sm:table-cell">
                          {new Date(o.created_at).toLocaleDateString("fr-FR", { timeZone: STORE_TIME_ZONE })}
                        </td>
                        <td className="px-4 py-3 text-right font-semibold tabular-nums text-foreground">
                          {TND(o.total_cents)}
                        </td>
                        <td className="px-4 py-3">
                          <span
                            className={`inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-bold ${ORDER_STATUS_COLORS[o.status as keyof typeof ORDER_STATUS_COLORS] ?? "bg-surface text-foreground"}`}
                          >
                            {adminStatusLabel(o.status, o.payment_method, o.paid_at, o.delivery_method)}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <div className="space-y-4">
            {/* Action queue — the shared « À traiter » rule (same count as Commandes) */}
            <section
              className={`rounded-[22px] p-5 ${
                needsAction > 0
                  ? "bg-[#0e1218] text-white"
                  : "border border-border bg-card"
              }`}
            >
              <p className={`text-[12px] font-bold ${needsAction > 0 ? "text-white/60" : "text-muted-foreground"}`}>
                À traiter
              </p>
              <p className={`mt-1 text-[28px] font-black leading-none tracking-[-0.02em] ${needsAction > 0 ? "text-white" : "text-foreground"}`}>
                {needsAction}
              </p>
              <p className={`mt-2 text-[12px] ${needsAction > 0 ? "text-white/70" : "text-muted-foreground"}`}>
                commande{needsAction === 1 ? "" : "s"} à préparer ou à expédier
                (payée{needsAction === 1 ? "" : "s"}, en préparation ou COD en
                attente).
              </p>
              {needsAction > 0 && (
                <Link
                  href="/admin/orders?actionable=1"
                  className="mt-3 inline-flex h-10 items-center rounded-full bg-primary px-4 text-[13px] font-extrabold text-primary-foreground transition hover:bg-[#b8042a]"
                >
                  Ouvrir la file
                </Link>
              )}
            </section>

            {/* Order-status distribution — real progress bars */}
            <section className="rounded-[22px] border border-border bg-card p-5">
              <h3 className="mb-4 inline-flex items-center gap-2 text-[18px] font-black text-foreground">
                <PackageIcon className="h-4 w-4" /> Répartition des commandes
              </h3>
              {distTotal === 0 ? (
                <p className="text-xs text-muted-foreground">
                  Aucune donnée pour le moment.
                </p>
              ) : (
                <ul className="space-y-3">
                  {(statusDist ?? [])
                    .slice()
                    .sort((a, b) => b.count - a.count)
                    .map((r) => {
                      const pct = Math.round((r.count / distTotal) * 100);
                      return (
                        <li key={r.status}>
                          <div className="flex items-center justify-between">
                            <span className="text-[12px] font-medium text-muted-foreground">
                              {orderStatusLabel(r.status)}
                            </span>
                            <span className="text-[12px] font-bold tabular-nums text-foreground">
                              {r.count} · {pct}%
                            </span>
                          </div>
                          <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-surface">
                            <div
                              className="h-full rounded-full bg-primary"
                              style={{ width: `${pct}%` }}
                            />
                          </div>
                        </li>
                      );
                    })}
                </ul>
              )}
            </section>
          </div>
        </div>
      )}
    </div>
  );
}
