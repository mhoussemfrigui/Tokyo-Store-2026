import type { Metadata } from "next";
import Link from "next/link";
import { ArrowUpRight, BarChart3, CreditCard, Package, ShoppingCart, TrendingUp, Users as UsersIcon, Wallet } from "lucide-react";

import { authQueries } from "@/modules/auth";
import { customerQueries } from "@/modules/customer";
import { orderService } from "@/modules/order/service";
import {
  getDailyOrdersSeries,
  getNewUsersSeries,
  getNewsletterSignupsSeries,
  getPaymentMethodBreakdown,
  getStatusDistribution,
  getTopSellingProducts,
} from "@/modules/order/queries";
import { countActiveSubscribers } from "@/modules/newsletter/queries";
import { cartEventService } from "@/modules/cart-event";
import { productQueries } from "@/modules/catalog/product";
import { ORDER_STATUS_COLORS, orderStatusLabel, paymentMethodLabel } from "@/lib/order/status";
import { aovCents, computeDelta, sharePct, splitWindow, sumBy, type Delta } from "@/lib/analytics/trend";
import { DeltaBadge } from "@/components/admin/delta-badge";
import { AdminCallout } from "@/components/admin/_components/filter-bar";
import { formatCents, minorToDinars } from "@/lib/price";
import { requirePermission } from "@/lib/auth/session";

export const metadata: Metadata = { title: "Statistiques" };

// One unified period selector drives every window-scoped panel on the page.
const WINDOWS = [7, 30, 90] as const;
type Window = (typeof WINDOWS)[number];

export default async function AnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<{ window?: string }>;
}) {
  await requirePermission("analytics", "view");
  const sp = await searchParams;
  const window: Window = WINDOWS.includes(Number(sp.window) as never) ? (Number(sp.window) as Window) : 30;

  const [
    userStats,
    customerStats,
    orderStats,
    activeSubs,
    dailyOrders2x,
    statusDist,
    topProducts,
    newsletter2x,
    newUsers2x,
    paymentBreakdown,
  ] = await Promise.all([
    authQueries.getUserStats(),
    customerQueries.getCustomerStats(),
    orderService.stats(),
    countActiveSubscribers(),
    getDailyOrdersSeries(window * 2),
    getStatusDistribution(),
    getTopSellingProducts(8, 90),
    getNewsletterSignupsSeries(window * 2),
    getNewUsersSeries(window * 2),
    getPaymentMethodBreakdown(window),
  ]);

  // Split each 2×window series into the previous + current windows, so every KPI
  // carries a period-over-period delta computed from the SAME proven SQL.
  // Orders/revenue use the ONE shared revenue base (paid orders, excluding
  // cancelled/refunded, NET of refunds) — the same as `orderService.stats()`
  // (the « total » sub-lines + Commandes) and the Encaissements breakdown.
  const orders = splitWindow(dailyOrders2x, window);
  const subs = splitWindow(newsletter2x, window);
  const newUsers = splitWindow(newUsers2x, window);

  const revenueCur = sumBy(orders.current, (d) => d.revenueCents);
  const revenuePrev = sumBy(orders.previous, (d) => d.revenueCents);
  const ordersCur = sumBy(orders.current, (d) => d.count);
  const ordersPrev = sumBy(orders.previous, (d) => d.count);
  const subsCur = sumBy(subs.current, (d) => d.count);
  const subsPrev = sumBy(subs.previous, (d) => d.count);
  const newUsersCur = sumBy(newUsers.current, (d) => d.count);
  const newUsersPrev = sumBy(newUsers.previous, (d) => d.count);

  const revenueDelta = computeDelta(revenueCur, revenuePrev);
  const ordersDelta = computeDelta(ordersCur, ordersPrev);
  const aovCur = aovCents(revenueCur, ordersCur);
  const aovDelta = computeDelta(aovCur, aovCents(revenuePrev, ordersPrev));
  const subsDelta = computeDelta(subsCur, subsPrev);
  const newUsersDelta = computeDelta(newUsersCur, newUsersPrev);

  // Cart-intent (uses the same window) — most-added with client/visitor split.
  const topAdded = await cartEventService.topAdded({ sinceDays: window, limit: 10 }).catch(() => []);
  const addedNameById = new Map(
    (topAdded.length > 0
      ? await productQueries.listProductsByIds(topAdded.map((r) => r.productId)).catch(() => [])
      : []
    ).map((p) => [p.id, p.name] as const),
  );
  const maxAdded = Math.max(1, ...topAdded.map((r) => r.units));

  // Combined daily series for the unified chart (current window only).
  const combinedSeries = orders.current.map((row, i) => ({
    day: row.day,
    orders: row.count,
    revenueCents: row.revenueCents,
    signups: subs.current[i]?.count ?? 0,
    newUsers: newUsers.current[i]?.count ?? 0,
  }));
  const maxRevenue = Math.max(1, ...combinedSeries.map((d) => d.revenueCents));
  const maxOrders = Math.max(1, ...combinedSeries.map((d) => d.orders));
  const maxSignups = Math.max(1, ...combinedSeries.map((d) => d.signups + d.newUsers));

  const settledRevenue = sumBy(paymentBreakdown, (r) => r.revenueCents);
  const windowLabel = `${window} j`;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-[22px] border border-border bg-card px-5 py-4">
        <div>
          <p className="max-w-3xl text-[14px] leading-relaxed text-muted-foreground">
            Données live — comparées à la période précédente de même durée. Chaque
            indicateur affiche sa tendance ({windowLabel} vs {windowLabel} précédents).
          </p>
        </div>
        <div className="flex items-center gap-2">
          <PeriodPicker active={window} />
          <Link
            href="/admin/orders"
            className="inline-flex h-11 items-center gap-2 rounded-full border-[1.5px] border-input bg-card px-4 text-[14px] font-bold text-foreground transition hover:bg-surface"
          >
            Voir les commandes
            <ArrowUpRight className="h-4 w-4" />
          </Link>
        </div>
      </div>

      {/* KPI strip — each with a period-over-period delta */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        <Kpi
          icon={ShoppingCart}
          label={`Commandes payées (${windowLabel})`}
          value={ordersCur.toLocaleString("fr-FR")}
          delta={ordersDelta}
          sub={`${orderStats.total.toLocaleString("fr-FR")} au total · ${orderStats.paid.toLocaleString("fr-FR")} payées`}
        />
        <Kpi
          icon={TrendingUp}
          label={`CA net (${windowLabel})`}
          value={formatCents(revenueCur)}
          delta={revenueDelta}
          sub={`${formatCents(orderStats.revenueCents)} depuis le début`}
        />
        <Kpi
          icon={Wallet}
          label="Panier moyen"
          value={formatCents(aovCur)}
          delta={aovDelta}
          sub={`sur ${ordersCur.toLocaleString("fr-FR")} commande${ordersCur === 1 ? "" : "s"} payée${ordersCur === 1 ? "" : "s"}`}
        />
        <Kpi
          icon={UsersIcon}
          label={`Comptes (${windowLabel})`}
          value={newUsersCur.toLocaleString("fr-FR")}
          delta={newUsersDelta}
          sub={`${userStats.total} comptes · ${customerStats.total} clients`}
        />
        <Kpi
          icon={BarChart3}
          label={`Newsletter (${windowLabel})`}
          value={subsCur.toLocaleString("fr-FR")}
          delta={subsDelta}
          sub={`${activeSubs} abonnés actifs`}
        />
      </div>

      {/* Daily series */}
      <section className="rounded-[28px] border border-border bg-card p-5 sm:p-6">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-[18px] font-black text-foreground">Activité quotidienne</h2>
            <p className="text-xs text-muted-foreground">
              {windowLabel} — barres = commandes (gauche), points = signups (droite).
            </p>
          </div>
          <Legend />
        </div>
        <DualBarChart data={combinedSeries} maxOrders={maxOrders} maxSignups={maxSignups} />
      </section>

      {/* Revenue spark + status + payment-method split */}
      <div className="grid gap-4 lg:grid-cols-3">
        {/* Revenue sparkline */}
        <section className="rounded-[28px] border border-border bg-card p-5 lg:col-span-2">
          <h2 className="text-[18px] font-black text-foreground">CA net ({windowLabel})</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Commandes payées par jour de commande, hors annulées / remboursées et
            remboursements déduits, en TND.
          </p>
          <RevenueAreaChart data={combinedSeries} max={maxRevenue} />
        </section>

        {/* Status distribution */}
        <section className="rounded-[28px] border border-border bg-card p-5">
          <h2 className="text-[18px] font-black text-foreground">Statuts</h2>
          <p className="mt-1 text-xs text-muted-foreground">Toutes les commandes.</p>
          <ul className="mt-4 space-y-2">
            {statusDist.length === 0 ? (
              <li className="text-sm text-muted-foreground">Aucune commande.</li>
            ) : (
              statusDist
                .sort((a, b) => b.count - a.count)
                .map((s) => (
                  <li key={s.status} className="flex items-center justify-between gap-3">
                    <span
                      className={`inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-bold ${ORDER_STATUS_COLORS[s.status as keyof typeof ORDER_STATUS_COLORS] ?? "bg-surface text-foreground"}`}
                    >
                      {orderStatusLabel(s.status)}
                    </span>
                    <span className="text-sm font-bold tabular-nums">{s.count}</span>
                  </li>
                ))
            )}
          </ul>
        </section>
      </div>

      {/* Payment-method breakdown (settled revenue over the window) */}
      <section className="rounded-[28px] border border-border bg-card p-5 sm:p-6">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="inline-flex items-center gap-2 text-[18px] font-black text-foreground">
              <CreditCard className="h-5 w-5 text-muted-foreground" /> Encaissements par moyen de paiement ({windowLabel})
            </h2>
            <p className="text-xs text-muted-foreground">
              Revenu réellement encaissé (paiement réglé, remboursements déduits, hors
              commandes annulées / remboursées) par méthode et par date d&apos;encaissement
              — le COD compte à la livraison.
            </p>
          </div>
          <span className="text-sm font-bold tabular-nums">{formatCents(settledRevenue)}</span>
        </div>
        {paymentBreakdown.length === 0 ? (
          <p className="mt-6 text-sm text-muted-foreground">
            Aucun encaissement sur la période.
          </p>
        ) : (
          <ul className="mt-4 space-y-3">
            {paymentBreakdown.map((p) => {
              const pct = sharePct(p.revenueCents, settledRevenue);
              return (
                <li key={p.method} className="flex items-center gap-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2 text-sm">
                      <span className="truncate font-medium">{paymentMethodLabel(p.method)}</span>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {p.orders} cmd · {pct} %
                      </span>
                    </div>
                    <div className="mt-1 h-2 w-full overflow-hidden rounded-full bg-surface">
                      <div className="h-full rounded-full bg-foreground" style={{ width: `${Math.max(pct, 2)}%` }} />
                    </div>
                  </div>
                  <span className="w-24 shrink-0 text-right text-sm font-bold tabular-nums">
                    {formatCents(p.revenueCents)}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* Top products */}
      <section className="rounded-[28px] border border-border bg-card p-5 sm:p-6">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-[18px] font-black text-foreground">Top produits (90 j)</h2>
            <p className="text-xs text-muted-foreground">
              Classement par quantité vendue sur les 90 derniers jours.
            </p>
          </div>
          <Package className="h-5 w-5 text-muted-foreground" />
        </div>
        {topProducts.length === 0 ? (
          <p className="mt-6 text-sm text-muted-foreground">
            Pas encore de ventes — quand vous commencerez à recevoir des
            commandes payées, le classement apparaîtra ici.
          </p>
        ) : (
          <ul className="mt-4 divide-y divide-border">
            {topProducts.map((p, i) => {
              const max = topProducts[0]?.quantity || 1;
              const pct = Math.round((p.quantity / max) * 100);
              return (
                <li key={p.productId} className="flex items-center gap-4 py-3">
                  <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-surface text-xs font-bold">
                    {i + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{p.productName}</p>
                    <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-surface">
                      <div
                        className="h-full bg-foreground"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  </div>
                  <div className="text-right text-xs tabular-nums">
                    <p className="font-bold">{p.quantity} ×</p>
                    <p className="text-muted-foreground">
                      {formatCents(p.revenueCents)}
                    </p>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* Most added-to-cart (client vs visitor) */}
      <section className="rounded-[28px] border border-border bg-card p-5 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-[18px] font-black text-foreground">Les plus ajoutés au panier ({windowLabel})</h2>
            <p className="text-xs text-muted-foreground">
              Intention d&apos;achat — classement par unités ajoutées au panier, segmenté{" "}
              <span className="font-semibold text-foreground">clients</span> (connectés) vs{" "}
              <span className="font-semibold text-foreground">visiteurs</span> (invités).
            </p>
          </div>
        </div>
        {topAdded.length === 0 ? (
          <p className="mt-6 text-sm text-muted-foreground">
            Aucun ajout au panier sur la période. Les ajouts (fiche produit + ajout rapide) seront
            comptabilisés ici, séparés clients / visiteurs.
          </p>
        ) : (
          <ul className="mt-4 divide-y divide-border">
            {topAdded.map((r, i) => {
              const clientPct = r.units > 0 ? Math.round((r.clientUnits / r.units) * 100) : 0;
              const barPct = Math.round((r.units / maxAdded) * 100);
              return (
                <li key={r.productId} className="flex items-center gap-4 py-3">
                  <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-surface text-xs font-bold">
                    {i + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{addedNameById.get(r.productId) ?? r.productId}</p>
                    {/* Split bar: client (foreground) vs visitor (muted). */}
                    <div className="mt-1 flex h-1.5 w-full overflow-hidden rounded-full bg-surface" style={{ width: `${Math.max(barPct, 6)}%` }}>
                      <div className="h-full bg-foreground" style={{ width: `${clientPct}%` }} />
                      <div className="h-full bg-primary/40" style={{ width: `${100 - clientPct}%` }} />
                    </div>
                  </div>
                  <div className="text-right text-xs tabular-nums">
                    <p className="font-bold">{r.units} ajout(s)</p>
                    <p className="text-muted-foreground">
                      {r.clientUnits} clients · {r.visitorUnits} visiteurs
                    </p>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        <div className="mt-3 flex items-center gap-3 text-[11px] text-muted-foreground">
          <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm bg-foreground" /> Clients</span>
          <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm bg-primary/40" /> Visiteurs</span>
        </div>
      </section>

      <AdminCallout tone="info">
        Les données ci-dessus s&apos;actualisent à chaque rechargement. Pour
        des exports CSV / branchements BI externes, utilisez l&apos;API headless{" "}
        <code className="rounded bg-surface px-1 py-0.5">/api/orders</code> (synchro incrémentale ERP)
        ou les vues SQL dans la console Postgres de Coolify.
      </AdminCallout>
    </div>
  );
}

function PeriodPicker({ active }: { active: Window }) {
  return (
    <div className="inline-flex items-center gap-1 rounded-[14px] bg-[var(--background)] p-1" role="group" aria-label="Période">
      {WINDOWS.map((w) => (
        <Link
          key={w}
          href={`/admin/analytics?window=${w}`}
          aria-current={w === active ? "true" : undefined}
          className={`rounded-[10px] px-3 py-1.5 text-[12px] transition ${
            w === active
              ? "bg-card font-extrabold text-primary shadow-[0_2px_8px_rgba(14,18,24,0.08)]"
              : "font-semibold text-muted-foreground hover:text-foreground"
          }`}
        >
          {w} j
        </Link>
      ))}
    </div>
  );
}

function Kpi({
  icon: Icon,
  label,
  value,
  sub,
  delta,
  invertColor,
}: {
  icon: React.ComponentType<{ className?: string; strokeWidth?: number }>;
  label: string;
  value: string;
  sub: string;
  delta?: Delta;
  /** Reserved: set for an inverse metric where a RISE is bad (e.g. a future
   *  refund/cancellation-rate KPI). Unused today — all current KPIs are
   *  positive-is-good — but kept as the correct affordance for DeltaBadge. */
  invertColor?: boolean;
}) {
  return (
    <div className="rounded-[24px] border border-border bg-card p-5">
      <div className="flex items-start justify-between">
        <p className="text-[12px] font-bold text-muted-foreground">
          {label}
        </p>
        <Icon className="h-5 w-5 text-primary" strokeWidth={2} />
      </div>
      <div className="mt-2 flex items-baseline gap-2">
        <p className="text-[28px] font-black tabular-nums tracking-[-0.02em] text-foreground">{value}</p>
        {delta && <DeltaBadge delta={delta} invertColor={invertColor} />}
      </div>
      <p className="mt-2 text-xs text-muted-foreground">{sub}</p>
    </div>
  );
}

function Legend() {
  return (
    <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
      <span className="inline-flex items-center gap-1.5">
        <span className="h-2.5 w-2.5 rounded-sm bg-foreground" /> Commandes
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span className="h-2.5 w-2.5 rounded-sm bg-primary" /> Signups newsletter
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span className="h-2.5 w-2.5 rounded-sm bg-[#3730a3]" /> Nouveaux comptes
      </span>
    </div>
  );
}

/**
 * Dual bar+dot chart, pure SVG, no recharts.
 * Bars = orders, primary dots = newsletter signups, accent dots = new users.
 */
function DualBarChart({
  data,
  maxOrders,
  maxSignups,
}: {
  data: Array<{ day: string; orders: number; signups: number; newUsers: number }>;
  maxOrders: number;
  maxSignups: number;
}) {
  const w = 1000;
  const h = 220;
  const padL = 36;
  const padR = 16;
  const padT = 12;
  const padB = 22;
  const inner = w - padL - padR;
  const innerH = h - padT - padB;
  const barW = Math.max(2, inner / Math.max(1, data.length) - 4);
  // Label density scales with the window (avoid 90 cramped ticks).
  const labelEvery = Math.max(1, Math.ceil(data.length / 12));

  return (
    <div className="mt-4 overflow-x-auto">
      <svg
        viewBox={`0 0 ${w} ${h}`}
        className="w-full"
        role="img"
        aria-label={`Activité quotidienne des ${data.length} derniers jours`}
      >
        {/* y-axis grid */}
        {[0, 0.25, 0.5, 0.75, 1].map((p) => {
          const y = padT + innerH - innerH * p;
          return (
            <g key={p}>
              <line
                x1={padL}
                x2={w - padR}
                y1={y}
                y2={y}
                stroke="currentColor"
                strokeOpacity={0.08}
              />
              <text x={4} y={y + 4} fontSize={10} fill="currentColor" opacity={0.5}>
                {Math.round(maxOrders * p)}
              </text>
            </g>
          );
        })}
        {/* bars */}
        {data.map((d, i) => {
          const x = padL + (inner / data.length) * i + 2;
          const barH = (d.orders / maxOrders) * innerH;
          const y = padT + innerH - barH;
          return (
            <rect
              key={`b-${i}`}
              x={x}
              y={y}
              width={barW}
              height={barH}
              fill="currentColor"
              opacity={0.85}
              rx={2}
            />
          );
        })}
        {/* signup dots — admin crimson (--primary #d40530), matches the legend */}
        {data.map((d, i) => {
          if (d.signups === 0) return null;
          const cx = padL + (inner / data.length) * i + barW / 2 + 2;
          const cy = padT + innerH - (d.signups / maxSignups) * innerH;
          return (
            <circle
              key={`s-${i}`}
              cx={cx}
              cy={cy}
              r={3}
              fill="rgb(212 5 48)"
            />
          );
        })}
        {/* new-user dots — admin info indigo (#3730a3), matches the legend */}
        {data.map((d, i) => {
          if (d.newUsers === 0) return null;
          const cx = padL + (inner / data.length) * i + barW / 2 + 2;
          const cy = padT + innerH - (d.newUsers / maxSignups) * innerH;
          return (
            <circle
              key={`u-${i}`}
              cx={cx}
              cy={cy}
              r={3}
              fill="rgb(55 48 163)"
            />
          );
        })}
        {/* x-axis labels — density scales with the window */}
        {data.map((d, i) => {
          if (i % labelEvery !== 0) return null;
          const x = padL + (inner / data.length) * i + barW / 2 + 2;
          const label = d.day.slice(5); // MM-DD
          return (
            <text
              key={`x-${i}`}
              x={x}
              y={h - 6}
              fontSize={10}
              textAnchor="middle"
              fill="currentColor"
              opacity={0.5}
            >
              {label}
            </text>
          );
        })}
      </svg>
    </div>
  );
}

/** Revenue-only area chart for the 2/3 panel below the daily chart. */
function RevenueAreaChart({
  data,
  max,
}: {
  data: Array<{ day: string; revenueCents: number }>;
  max: number;
}) {
  const w = 700;
  const h = 160;
  const padL = 40;
  const padR = 16;
  const padT = 10;
  const padB = 22;
  const inner = w - padL - padR;
  const innerH = h - padT - padB;
  const labelEvery = Math.max(1, Math.ceil(data.length / 10));

  const points = data.map((d, i) => {
    const x = padL + (inner / Math.max(1, data.length - 1)) * i;
    const y = padT + innerH - (d.revenueCents / max) * innerH;
    return [x, y] as const;
  });
  const path = points.map((p, i) => `${i === 0 ? "M" : "L"}${p[0]},${p[1]}`).join(" ");
  const area = `${path} L${padL + inner},${padT + innerH} L${padL},${padT + innerH} Z`;

  return (
    <div className="mt-4 overflow-x-auto">
      <svg viewBox={`0 0 ${w} ${h}`} className="w-full" role="img" aria-label="Revenu">
        {[0, 0.5, 1].map((p) => {
          const y = padT + innerH - innerH * p;
          return (
            <g key={p}>
              <line x1={padL} x2={w - padR} y1={y} y2={y} stroke="currentColor" strokeOpacity={0.08} />
              <text x={4} y={y + 4} fontSize={10} fill="currentColor" opacity={0.5}>
                {Math.round(minorToDinars(max * p)).toLocaleString("fr-FR")}
              </text>
            </g>
          );
        })}
        <path d={area} fill="rgb(212 5 48)" fillOpacity={0.12} />
        <path d={path} fill="none" stroke="rgb(212 5 48)" strokeWidth={2} />
        {data.map((d, i) => {
          if (i % labelEvery !== 0) return null;
          const x = padL + (inner / Math.max(1, data.length - 1)) * i;
          return (
            <text
              key={i}
              x={x}
              y={h - 6}
              fontSize={10}
              textAnchor="middle"
              fill="currentColor"
              opacity={0.5}
            >
              {d.day.slice(5)}
            </text>
          );
        })}
      </svg>
    </div>
  );
}
