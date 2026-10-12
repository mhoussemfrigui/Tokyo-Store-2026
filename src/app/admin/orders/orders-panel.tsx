"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { ChevronRight, Download, FileText, Loader2, Plus, RotateCcw, ShieldAlert, ShieldCheck, UserX, X } from "lucide-react";

import { AdminToolbar, SegmentedFilter, AdminSearch, AdminNote } from "@/components/admin/_components/filter-bar";
import { bulkSetOrderSpamAction, bulkUpdateOrderStatusAction } from "@/lib/actions/order";
import {
  ORDER_STATUSES,
  ORDER_STATUS_LABELS,
  ORDER_STATUS_COLORS,
  adminStatusLabel,
} from "@/lib/order/status";
import { formatCents, formatMoneyWithCurrency } from "@/lib/price";
import {
  FULFILMENT_BADGE_LABELS,
  FULFILMENT_BADGE_COLORS,
  REFUND_BADGE_LABELS,
  REFUND_BADGE_COLORS,
  type FulfilmentBadge,
  type RefundBadge,
} from "@/lib/order/badges";
import { ORDER_CHANNEL_LABELS, ORDER_CHANNELS } from "@/lib/order/channel-labels";
import { ORDER_SOURCES, orderSourceLabel } from "@/lib/order/order-source";
import type { OrderChannel } from "@/modules/order/schema";

/**
 * Compact payment-method labels for the dense list (never the raw enum). These
 * are intentionally SHORTER than the customer-facing `ORDER_PAYMENT_METHOD_LABELS`
 * so the column stays tight; `konnect` is legacy (provider removed) but kept so a
 * historical order still reads a name.
 */
const PAYMENT_LABELS: Record<string, string> = {
  cod: "Livraison",
  konnect: "Konnect (obs.)",
  clictopay: "ClicToPay",
  flouci: "Flouci",
  card_stripe: "Carte",
  cash: "Espèces",
  bank_transfer: "Virement",
};

type Order = {
  id: string;
  orderNumber: string;
  userId: string | null;
  contactEmail: string;
  contactPhone: string | null;
  isGuest: boolean;
  status: "pending" | "paid" | "preparing" | "shipped" | "delivered" | "cancelled" | "refunded";
  paymentMethod: string | null;
  /** Delivery method — drives the « Retirée » relabel for a collected pickup order. */
  deliveryMethod: string | null;
  totalCents: number;
  currency: string;
  invoiceIssued: boolean;
  /** True when the order has at least one return (SAV/retour). */
  hasReturn: boolean;
  /** Derived shipment progress — "partial" shows a chip; "full"/"none" don't. */
  fulfilmentBadge: FulfilmentBadge;
  /** Derived refund state — "partial"/"full" show a chip; "none" doesn't. */
  refundBadge: RefundBadge;
  createdAt: string;
  paidAt: string | null;
  /** Flagged as spam (triage) — shows a « Spam » badge; only visible in the Spam view. */
  flaggedSpam: boolean;
  /** Sales channel (origin) — drives the « Origine » filter + a row badge. */
  channel: OrderChannel;
  /** Marketing source (migration 0198) — drives the « Source » filter + a row badge. NULL for storefront. */
  source: string | null;
  /** Compact line summary (first product name + line/unit counts) for the list. */
  productSummary: { firstName: string; lineCount: number; totalQty: number } | null;
};

export function OrdersPanel({
  orders,
  stats,
  counts,
  filters,
  guestOnly,
  currentSearch,
  currentPhone,
  canCreateOrder,
  canManage,
}: {
  /** ONE server page, already filtered by `filters` (keyset-paged by the page). */
  orders: Order[];
  /** `orderService.stats()` — GLOBAL figures (not just the loaded page):
   *  `paid`/`revenueCents` = settled orders net of refunds, excluding
   *  cancelled/refunded; `actionable` = the « À traiter » queue size. */
  stats: { total: number; paid: number; revenueCents: number; actionable: number };
  /** `orderService.listFilterCounts()` — chip counts over the whole store under
   *  the current guest/search filter (not just the loaded page). */
  counts: {
    total: number;
    byStatus: Partial<Record<Order["status"], number>>;
    byChannel: Partial<Record<OrderChannel, number>>;
    /** Orders per marketing source — the « Source » chips (only sources with orders). */
    bySource: Record<string, number>;
    actionable: number;
    withReturn: number;
    /** Flagged-spam orders — the « Spam » chip count. */
    spam: number;
  };
  /** The SERVER filters in force (URL `status` / `actionable=1` / `returns=1` /
   *  `spam=1` / `channel` / `source`) — the chips, the « À traiter » KPI, « Retours »,
   *  « Spam », « Origine » and « Source » navigate to change them. */
  filters: {
    status: Order["status"] | null;
    actionable: boolean;
    returns: boolean;
    spam: boolean;
    channel: OrderChannel | null;
    source: string | null;
  };
  guestOnly: boolean;
  currentSearch: string;
  currentPhone: string;
  /** Any of ORDER_NEW_VIEW_GRANTS (orders_new:view OR orders:manage — the /new
   *  page's own guard, src/lib/rbac/nav-access.ts) — hide the « Nouvelle
   *  commande » button from an operator the /new page would 404, and show it to
   *  an orders:manage role that has no orders_new grant. */
  canCreateOrder: boolean;
  /** orders:manage — gates the bulk selection checkboxes + status toolbar (their
   *  action enforces it server-side; a view-only agent must not see 403ing controls). */
  canManage: boolean;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  // Seed the box from whichever server param is set — number/email (`q`) or
  // phone. Submitting routes both so the server filter (incl. case-insensitive
  // phone ilike) runs; the same value also drives the client-side filter below.
  const [search, setSearch] = useState(currentSearch || currentPhone);
  // Status chip / « À traiter » queue (the KPI, or `?actionable=1` from the
  // dashboard's « Ouvrir la file ») / « Retours » are SERVER filters read from
  // the URL — so an order older than the loaded page stays reachable.
  const statusFilter = filters.status ?? "all";
  const actionableOnly = filters.actionable;
  const returnsOnly = filters.returns;
  const spamOnly = filters.spam;
  const channelFilter = filters.channel;
  // Sales channels that actually have orders (over the current non-spam base).
  const channelsPresent = ORDER_CHANNELS.filter((ch) => (counts.byChannel[ch] ?? 0) > 0);
  // Only worth surfacing when there's a MIX (a single-channel store gains nothing).
  const showChannelChips = channelsPresent.length > 1 || channelFilter != null;
  // « Source » — marketing acquisition origin (manual orders). Shown once ANY
  // order carries a source (unlike channel, a single source is still worth
  // filtering, since the rest of the list simply has none).
  const sourceFilter = filters.source;
  const sourcesPresent = ORDER_SOURCES.filter((s) => (counts.bySource[s.value] ?? 0) > 0);
  const showSourceChips = sourcesPresent.length > 0 || sourceFilter != null;
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkPending, startBulkTransition] = useTransition();
  const [bulkFeedback, setBulkFeedback] = useState<{ kind: "ok" | "err"; msg: string } | null>(
    null,
  );

  // The server already applied every filter; the box only narrows the loaded
  // page live while typing (Enter re-queries the server).
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return orders;
    return orders.filter(
      (o) =>
        o.orderNumber.toLowerCase().includes(q) ||
        o.contactEmail.toLowerCase().includes(q) ||
        (o.contactPhone?.toLowerCase().includes(q) ?? false),
    );
  }, [orders, search]);

  // Change the server filters — always back to the first page (drop `cursor`).
  const pushFilters = (next: {
    status?: Order["status"] | null;
    actionable?: boolean;
    returns?: boolean;
    spam?: boolean;
    channel?: OrderChannel | null;
    source?: string | null;
  }) => {
    const p = new URLSearchParams(searchParams);
    p.delete("cursor");
    if (next.status !== undefined) {
      if (next.status) p.set("status", next.status);
      else p.delete("status");
    }
    if (next.actionable !== undefined) {
      if (next.actionable) p.set("actionable", "1");
      else p.delete("actionable");
    }
    if (next.returns !== undefined) {
      if (next.returns) p.set("returns", "1");
      else p.delete("returns");
    }
    if (next.spam !== undefined) {
      if (next.spam) p.set("spam", "1");
      else p.delete("spam");
    }
    if (next.channel !== undefined) {
      if (next.channel) p.set("channel", next.channel);
      else p.delete("channel");
    }
    if (next.source !== undefined) {
      if (next.source) p.set("source", next.source);
      else p.delete("source");
    }
    router.push(`/admin/orders?${p.toString()}`);
  };

  // Search box submits one `q` term; the server ORs it across order number,
  // email AND phone in a single OR group (see orderService.list), so all three
  // match. The client filter then narrows within the returned page.
  const submitSearch = () => {
    const p = new URLSearchParams(searchParams);
    const term = search.trim();
    if (term) p.set("q", term);
    else p.delete("q");
    p.delete("phone"); // legacy param — folded into `q` now
    p.delete("cursor");
    router.push(`/admin/orders?${p.toString()}`);
  };

  const toggleGuestOnly = () => {
    const p = new URLSearchParams(searchParams);
    if (guestOnly) p.delete("guestOnly");
    else p.set("guestOnly", "1");
    p.delete("cursor");
    router.push(`/admin/orders?${p.toString()}`);
  };

  // Chip counts come from the server (whole store under the guest/search filter).
  const statusCounts: Record<string, number> = { all: counts.total, ...counts.byStatus };
  // The KPI shows the GLOBAL queue; under a guest/search filter the queue the
  // click would load can be smaller — the hint says so.
  const actionableCount = counts.actionable;
  const returnsCount = counts.withReturn;
  const spamCount = counts.spam;

  // Drop selection rows that have been filtered out — keeps "all/none" toggles honest.
  const filteredIds = useMemo(() => new Set(filtered.map((o) => o.id)), [filtered]);
  const visibleSelected = useMemo(
    () => Array.from(selectedIds).filter((id) => filteredIds.has(id)),
    [selectedIds, filteredIds],
  );
  const allVisibleSelected =
    filtered.length > 0 && visibleSelected.length === filtered.length;

  const toggleOne = (id: string) =>
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const toggleAllVisible = () =>
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (allVisibleSelected) {
        for (const id of filteredIds) next.delete(id);
      } else {
        for (const id of filteredIds) next.add(id);
      }
      return next;
    });

  // 'cancelled' is intentionally NOT bulk-exposed: cancelling is destructive +
  // restocks + reverses promotions, so it stays a per-order action behind a confirm.
  const runBulkStatus = (toStatus: "preparing" | "shipped" | "delivered") => {
    if (visibleSelected.length === 0) return;
    setBulkFeedback(null);
    startBulkTransition(async () => {
      const res = await bulkUpdateOrderStatusAction({
        orderIds: visibleSelected,
        toStatus,
      });
      if (res.ok) {
        setBulkFeedback({ kind: "ok", msg: res.message ?? "OK" });
        setSelectedIds(new Set());
      } else {
        setBulkFeedback({ kind: "err", msg: res.message });
      }
    });
  };

  // Bulk spam-flag / unflag — the triage workhorse. In the Spam view this un-flags
  // (restore); elsewhere it flags (they leave the default view on refresh).
  const runBulkSpam = (spam: boolean) => {
    if (visibleSelected.length === 0) return;
    setBulkFeedback(null);
    startBulkTransition(async () => {
      const res = await bulkSetOrderSpamAction({ orderIds: visibleSelected, spam });
      if (res.ok) {
        setBulkFeedback({ kind: "ok", msg: res.message ?? "OK" });
        setSelectedIds(new Set());
      } else {
        setBulkFeedback({ kind: "err", msg: res.message });
      }
    });
  };

  // CSV export — re-uses the existing /admin/orders/export route. Caller
  // tacks ?ids=...&ids=... so the backend only includes the picked rows.
  const exportSelectedHref = (() => {
    const p = new URLSearchParams();
    for (const id of visibleSelected) p.append("ids", id);
    return `/admin/orders/export?${p.toString()}`;
  })();

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-[22px] border border-border bg-card px-5 py-4">
        <AdminNote className="max-w-3xl">
          Toutes les commandes (payées et en attente). Cliquez sur une ligne pour
          ouvrir le détail et faire avancer le statut.{" "}
          <Link href="/admin/system/api?tab=erp" className="font-medium text-foreground underline underline-offset-2">
            Intégration ERP / API →
          </Link>
        </AdminNote>
        {canCreateOrder && (
          <Link
            href="/admin/orders/new"
            className="inline-flex h-11 shrink-0 items-center gap-2 rounded-full bg-primary px-5 text-[14px] font-extrabold text-primary-foreground hover:bg-[#b8042a]"
          >
            <Plus className="h-4 w-4" /> Nouvelle commande
          </Link>
        )}
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Kpi label="Total commandes" value={stats.total.toString()} />
        <Kpi
          label="À traiter"
          value={stats.actionable.toString()}
          accent
          active={actionableOnly}
          onClick={() => pushFilters({ actionable: !actionableOnly, status: null, spam: false })}
          hint={
            actionableOnly
              ? "Filtre actif — cliquer pour tout afficher"
              : actionableCount === stats.actionable
                ? "Cliquer pour filtrer"
                : `${actionableCount} avec les filtres actifs — cliquer pour filtrer`
          }
        />
        <Kpi label="Payées" value={stats.paid.toString()} hint="Hors annulées / remboursées" />
        <Kpi
          label="Chiffre d'affaires net"
          value={formatCents(stats.revenueCents)}
          hint="Commandes payées, remboursements déduits"
        />
      </div>

      {/* Search + filter chips */}
      <div className="space-y-3">
        <AdminToolbar>
          <div className="relative min-w-[16rem] flex-1">
            <AdminSearch
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submitSearch();
              }}
              placeholder="Rechercher par numéro, email ou téléphone…"
              className="w-full pr-10"
            />
            {search && (
              <button
                type="button"
                onClick={() => {
                  setSearch("");
                  const p = new URLSearchParams(searchParams);
                  p.delete("q");
                  p.delete("phone");
                  router.push(`/admin/orders?${p.toString()}`);
                }}
                aria-label="Effacer la recherche"
                className="absolute right-3.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
          {/* Status quick-filter — one segmented track with live counts. Selecting
              a status clears the « À traiter » / Spam scopes, exactly as the old
              chips did. No status is raised while an actionable/spam scope is on. */}
          <SegmentedFilter<string>
            ariaLabel="Filtrer par statut"
            value={actionableOnly || spamOnly ? "" : statusFilter}
            onChange={(v) =>
              v === "all"
                ? pushFilters({ status: null, actionable: false, spam: false })
                : pushFilters({ status: v as Order["status"], actionable: false, spam: false })
            }
            options={[
              { value: "all", label: "Tous", count: statusCounts.all ?? 0 },
              ...ORDER_STATUSES.map((s) => ({
                value: s,
                label: ORDER_STATUS_LABELS[s],
                count: statusCounts[s] ?? 0,
              })),
            ]}
          />
        </AdminToolbar>
        <div className="flex flex-wrap items-center gap-2">
          {/* Guest-only toggle — server-driven (user_id IS NULL). */}
          <button
            type="button"
            onClick={toggleGuestOnly}
            className={`inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-xs font-semibold transition ${
              guestOnly
                ? "bg-foreground text-background"
                : "border border-border bg-card text-foreground hover:bg-surface"
            }`}
          >
            <UserX className="h-3.5 w-3.5" /> Invités
          </button>
          {/* Retours quick-filter — show only orders that have a return (SAV). */}
          <button
            type="button"
            onClick={() => pushFilters({ returns: !returnsOnly })}
            aria-pressed={returnsOnly}
            className={`inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-xs font-semibold transition ${
              returnsOnly
                ? "bg-[#b45309] text-white"
                : "border border-border bg-card text-foreground hover:bg-surface"
            }`}
          >
            <RotateCcw className="h-3.5 w-3.5" /> Retours ({returnsCount})
          </button>
          {/* Spam scope — show ONLY flagged-spam orders (hidden from every other
              view). Toggling it clears the « À traiter » queue (spam is never
              actionable). Hidden when there's no spam AND the filter isn't active. */}
          {(spamCount > 0 || spamOnly) && (
            <button
              type="button"
              onClick={() => pushFilters({ spam: !spamOnly, actionable: false, status: null })}
              aria-pressed={spamOnly}
              className={`inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-xs font-semibold transition ${
                spamOnly
                  ? "bg-primary text-white"
                  : "border border-border bg-card text-foreground hover:bg-surface"
              }`}
            >
              <ShieldAlert className="h-3.5 w-3.5" /> Spam ({spamCount})
            </button>
          )}
          {/* Origine / Canal — filter by sales channel; only when the store has a
              MIX of channels (or one is currently selected). A pressed chip resets. */}
          {showChannelChips && (
            <>
              <span className="mx-1 hidden h-5 w-px self-center bg-border sm:inline-block" aria-hidden />
              {ORDER_CHANNELS.filter(
                (ch) => (counts.byChannel[ch] ?? 0) > 0 || channelFilter === ch,
              ).map((ch) => (
                <button
                  key={ch}
                  type="button"
                  onClick={() => pushFilters({ channel: channelFilter === ch ? null : ch })}
                  aria-pressed={channelFilter === ch}
                  title="Origine / Canal de la commande"
                  className={`inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-xs font-semibold transition ${
                    channelFilter === ch
                      ? "bg-primary text-white"
                      : "border border-border bg-card text-foreground hover:bg-surface"
                  }`}
                >
                  {ORDER_CHANNEL_LABELS[ch]} ({counts.byChannel[ch] ?? 0})
                </button>
              ))}
            </>
          )}
          {/* Source — filter by marketing/acquisition origin (Facebook, phone…);
              shown once any order carries a source. A pressed chip resets. */}
          {showSourceChips && (
            <>
              <span className="mx-1 hidden h-5 w-px self-center bg-border sm:inline-block" aria-hidden />
              {ORDER_SOURCES.filter(
                (s) => (counts.bySource[s.value] ?? 0) > 0 || sourceFilter === s.value,
              ).map((s) => (
                <button
                  key={s.value}
                  type="button"
                  onClick={() => pushFilters({ source: sourceFilter === s.value ? null : s.value })}
                  aria-pressed={sourceFilter === s.value}
                  title="Source de la commande"
                  className={`inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-xs font-semibold transition ${
                    sourceFilter === s.value
                      ? "bg-primary text-white"
                      : "border border-border bg-card text-foreground hover:bg-surface"
                  }`}
                >
                  {s.label} ({counts.bySource[s.value] ?? 0})
                </button>
              ))}
            </>
          )}
        </div>
      </div>

      {/* Bulk-actions toolbar — only visible when ≥1 selected. */}
      {visibleSelected.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-full bg-[#0e1218] px-4 py-3 text-white">
          <p className="text-sm font-semibold">
            {visibleSelected.length} commande{visibleSelected.length > 1 ? "s" : ""} sélectionnée
            {visibleSelected.length > 1 ? "s" : ""}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            {/* Bulk STATUS actions need orders:manage (bulkUpdateOrderStatusAction
                enforces it) — hidden from a view-only agent. Selection + CSV export
                stay: the export route is orders:view. */}
            {canManage && (
              <>
                {/* Forward-status actions don't apply in the Spam view (spam orders
                    aren't fulfilled) — hidden there. */}
                {!spamOnly && (
                  <>
                    <button
                      type="button"
                      onClick={() => runBulkStatus("preparing")}
                      disabled={bulkPending}
                      className="inline-flex h-9 items-center gap-1 rounded-full bg-[#2a2e35] px-3 text-xs font-semibold text-white transition hover:bg-[#3a3f48] disabled:opacity-60"
                    >
                      {bulkPending && <Loader2 className="h-3 w-3 animate-spin" />}
                      Marquer comme préparation
                    </button>
                    <button
                      type="button"
                      onClick={() => runBulkStatus("shipped")}
                      disabled={bulkPending}
                      className="inline-flex h-9 items-center gap-1 rounded-full bg-[#2a2e35] px-3 text-xs font-semibold text-white transition hover:bg-[#3a3f48] disabled:opacity-60"
                    >
                      {bulkPending && <Loader2 className="h-3 w-3 animate-spin" />}
                      Marquer comme expédié
                    </button>
                    <button
                      type="button"
                      onClick={() => runBulkStatus("delivered")}
                      disabled={bulkPending}
                      className="inline-flex h-9 items-center gap-1 rounded-full bg-[#2a2e35] px-3 text-xs font-semibold text-white transition hover:bg-[#3a3f48] disabled:opacity-60"
                    >
                      {bulkPending && <Loader2 className="h-3 w-3 animate-spin" />}
                      Marquer comme livré
                    </button>
                  </>
                )}
                {/* Spam triage: flag in the normal view, restore in the Spam view. */}
                <button
                  type="button"
                  onClick={() => runBulkSpam(!spamOnly)}
                  disabled={bulkPending}
                  className={`inline-flex h-9 items-center gap-1 rounded-full px-3 text-xs font-semibold transition disabled:opacity-60 ${
                    spamOnly
                      ? "bg-[#2a2e35] text-white hover:bg-[#3a3f48]"
                      : "bg-primary text-white hover:bg-[#b8042a]"
                  }`}
                >
                  {bulkPending ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : spamOnly ? (
                    <ShieldCheck className="h-3 w-3" />
                  ) : (
                    <ShieldAlert className="h-3 w-3" />
                  )}
                  {spamOnly ? "Retirer du spam" : "Marquer comme spam"}
                </button>
              </>
            )}
            <a
              href={exportSelectedHref}
              className="inline-flex h-9 items-center gap-1 rounded-full bg-[#2a2e35] px-3 text-xs font-semibold text-white transition hover:bg-[#3a3f48]"
            >
              <Download className="h-3 w-3" /> Exporter sélection (CSV)
            </a>
            <button
              type="button"
              onClick={() => setSelectedIds(new Set())}
              disabled={bulkPending}
              className="inline-flex h-9 items-center rounded-full px-3 text-xs font-medium text-white/70 hover:text-white disabled:opacity-60"
            >
              Désélectionner
            </button>
          </div>
          {bulkFeedback && (
            <p
              className={`w-full text-xs ${
                bulkFeedback.kind === "ok" ? "text-white" : "text-[#ffb3c0]"
              }`}
            >
              {bulkFeedback.msg}
            </p>
          )}
        </div>
      )}

      {filtered.length === 0 ? (
        <div className="rounded-3xl border border-dashed border-border bg-card p-12 text-center text-sm text-muted-foreground">
          {stats.total === 0
            ? "Aucune commande pour le moment."
            : "Aucune commande ne correspond aux filtres."}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-[22px] border border-border bg-card">
          <table className="w-full text-sm">
            <thead className="border-b border-border bg-[#fbf9f8] text-left text-[12px] font-bold uppercase tracking-[0.06em] text-[#8a857f]">
              <tr>
                <th className="px-5 py-3 w-10">
                  <input
                    type="checkbox"
                    checked={allVisibleSelected}
                    onChange={toggleAllVisible}
                    aria-label="Tout sélectionner"
                    className="h-4 w-4 accent-[var(--primary)]"
                  />
                </th>
                <th className="px-5 py-3">N°</th>
                <th className="px-5 py-3">Client</th>
                <th className="px-5 py-3">Paiement</th>
                <th className="px-5 py-3">Total</th>
                <th className="px-5 py-3">Statut</th>
                <th className="px-5 py-3">Date</th>
                <th className="px-5 py-3 text-right">Détail</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {filtered.map((o) => (
                <OrderRow
                  key={o.id}
                  order={o}
                  selected={selectedIds.has(o.id)}
                  onToggleSelected={() => toggleOne(o.id)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function OrderRow({
  order,
  selected,
  onToggleSelected,
}: {
  order: Order;
  selected: boolean;
  onToggleSelected: () => void;
}) {
  return (
    <tr className="transition hover:bg-[#fffbfb]">
      <td className="px-5 py-3">
        <input
          type="checkbox"
          checked={selected}
          onChange={onToggleSelected}
          aria-label={`Sélectionner ${order.orderNumber}`}
          className="h-4 w-4 accent-[var(--primary)]"
        />
      </td>
      <td className="px-5 py-3 font-medium">
        <div className="flex items-center gap-2">
          <Link
            href={`/admin/orders/${order.id}`}
            className="text-foreground hover:text-primary hover:underline"
          >
            {order.orderNumber}
          </Link>
          {order.isGuest && (
            <span className="inline-flex items-center gap-1 rounded-full bg-[#fff4e0] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[#b45309]">
              <UserX className="h-3 w-3" /> Invité
            </span>
          )}
          {/* Origin badge — only for NON-storefront orders (storefront is the norm,
              so badging it would just add noise). */}
          {order.channel !== "storefront" && (
            <span className="inline-flex items-center rounded-full bg-[#fdecef] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[#d40530]">
              {ORDER_CHANNEL_LABELS[order.channel]}
            </span>
          )}
          {/* Source badge — the acquisition origin (Facebook, phone…) when recorded. */}
          {orderSourceLabel(order.source) && (
            <span className="inline-flex items-center rounded-full bg-[#eef2ff] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[#3730a3]">
              {orderSourceLabel(order.source)}
            </span>
          )}
        </div>
      </td>
      <td className="px-5 py-3 text-muted-foreground">
        <div className="flex flex-col">
          <span>{order.contactEmail}</span>
          {order.contactPhone && (
            <span className="text-[11px] text-muted-foreground/70">{order.contactPhone}</span>
          )}
          {/* Compact line summary — the first product + a "+N" when the order has
              more lines, and the total unit count. Snapshot names (survive a
              product delete). */}
          {order.productSummary && (
            <span className="mt-0.5 truncate text-[11px] text-muted-foreground/70" title={order.productSummary.firstName}>
              {order.productSummary.firstName}
              {order.productSummary.lineCount > 1 && ` +${order.productSummary.lineCount - 1}`}
              {" · "}
              {order.productSummary.totalQty} art.
            </span>
          )}
        </div>
      </td>
      <td className="px-5 py-3">
        {order.paymentMethod ? (
          <span className="inline-flex items-center rounded-full border border-border bg-surface/60 px-2 py-0.5 text-[11px] font-medium text-foreground">
            {PAYMENT_LABELS[order.paymentMethod] ?? order.paymentMethod}
          </span>
        ) : (
          <span className="text-[11px] text-muted-foreground/60">—</span>
        )}
      </td>
      <td className="px-5 py-3 font-semibold">
        <div className="flex items-center gap-1.5">
          {formatMoneyWithCurrency(order.totalCents, order.currency)}
          {order.invoiceIssued && (
            <FileText className="h-3.5 w-3.5 text-muted-foreground" aria-label="Facture émise" />
          )}
          {order.hasReturn && (
            <RotateCcw className="h-3.5 w-3.5 text-[#b45309]" aria-label="Retour (SAV)" />
          )}
        </div>
      </td>
      <td className="px-5 py-3">
        <div className="flex flex-col items-start gap-1">
          <span
            className={`inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-bold ${ORDER_STATUS_COLORS[order.status]}`}
          >
            {adminStatusLabel(order.status, order.paymentMethod, order.paidAt, order.deliveryMethod)}
          </span>
          {/* Spam badge — only surfaces in the Spam view (flagged rows are hidden
              elsewhere), a clear marker that this row is triaged out. */}
          {order.flaggedSpam && (
            <span className="inline-flex items-center gap-1 rounded-full bg-[#fdecef] px-2 py-0.5 text-[10px] font-semibold uppercase text-[#d40530]">
              <ShieldAlert className="h-3 w-3" /> Spam
            </span>
          )}
          {/* Derived badges (L1) — additive to the status: a partial shipment
              in progress, and a partial/full refund a non-`refunded` status hides. */}
          {order.fulfilmentBadge === "partial" && (
            <span
              className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${FULFILMENT_BADGE_COLORS.partial}`}
            >
              {FULFILMENT_BADGE_LABELS.partial}
            </span>
          )}
          {/* Hide only the redundant "Remboursée" chip on a refunded order;
              keep "Remboursement partiel" visible. */}
          {order.refundBadge !== "none" &&
            !(order.status === "refunded" && order.refundBadge === "full") && (
              <span
                className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${REFUND_BADGE_COLORS[order.refundBadge]}`}
              >
                {REFUND_BADGE_LABELS[order.refundBadge]}
              </span>
            )}
        </div>
      </td>
      <td className="px-5 py-3 text-[11px] text-muted-foreground">
        {new Date(order.createdAt).toLocaleDateString("fr-FR")}
      </td>
      <td className="px-5 py-3 text-right">
        <Link
          href={`/admin/orders/${order.id}`}
          className="inline-flex h-8 items-center gap-1 rounded-full border border-border bg-card px-3 text-xs font-semibold text-foreground transition hover:bg-surface"
        >
          Ouvrir <ChevronRight className="h-3 w-3" />
        </Link>
      </td>
    </tr>
  );
}

function Kpi({
  label,
  value,
  accent,
  onClick,
  active,
  hint,
}: {
  label: string;
  value: string;
  accent?: boolean;
  onClick?: () => void;
  active?: boolean;
  hint?: string;
}) {
  // `accent`/`active` use the olive --primary (visible), NOT --accent — which in
  // the admin theme is a near-white neutral that rendered the value invisible.
  const box = `rounded-[22px] border p-5 text-left transition ${
    active
      ? "border-primary bg-[var(--accent)]"
      : accent
        ? "border-[#f6d3dc] bg-[var(--accent)]"
        : "border-border bg-card"
  } ${onClick ? "w-full cursor-pointer hover:border-primary/60" : ""}`;
  const inner = (
    <>
      <p className="text-[12px] font-bold text-muted-foreground">{label}</p>
      <p className={`mt-1.5 text-[28px] font-black leading-none tracking-[-0.02em] ${accent || active ? "text-primary" : ""}`}>
        {value}
      </p>
      {hint && <p className="mt-1.5 text-[12px] text-muted-foreground">{hint}</p>}
    </>
  );
  return onClick ? (
    <button type="button" onClick={onClick} aria-pressed={active} className={box}>
      {inner}
    </button>
  ) : (
    <div className={box}>{inner}</div>
  );
}
