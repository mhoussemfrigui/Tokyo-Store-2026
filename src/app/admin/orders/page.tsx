import type { Metadata } from "next";
import Link from "next/link";

import { orderService } from "@/modules/order/service";
import { returnService } from "@/modules/order/returns.service";
import type { OrderStatus, OrderChannel } from "@/modules/order/schema";
import { requirePermission } from "@/lib/auth/session";
import { resolveUserPermissions, permissionSetAllows, permissionSetAllowsAny } from "@/lib/rbac/authorize";
import { ORDER_NEW_VIEW_GRANTS } from "@/lib/rbac/nav-access";
import { deriveFulfilmentBadge, deriveRefundBadge } from "@/lib/order/badges";
import { ORDER_STATUSES } from "@/lib/order/status";
import { ORDER_CHANNELS } from "@/lib/order/channel-labels";
import { ORDER_SOURCE_VALUES } from "@/lib/order/order-source";
import { OrdersPanel } from "./orders-panel";

export const metadata: Metadata = { title: "Commandes" };

/** Rows per page — the list pages on a `(created_at, id)` keyset cursor. */
const PAGE_SIZE = 50;

export default async function OrdersAdminPage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string;
    phone?: string;
    guestOnly?: string;
    status?: string;
    actionable?: string;
    returns?: string;
    spam?: string;
    channel?: string;
    source?: string;
    cursor?: string;
  }>;
}) {
  const sp = await searchParams;
  const session = await requirePermission("orders", "view");
  // « Nouvelle commande » is its own tab/grant (orders_new) now; only surface the
  // create button when the viewer can actually open it — the SAME OR as the /new
  // page guard (orders_new:view OR orders:manage), so it neither 404s nor hides.
  const perms = await resolveUserPermissions(session.user.id);
  const canCreateOrder = permissionSetAllowsAny(perms, ORDER_NEW_VIEW_GRANTS);
  // The bulk selection + status toolbar call orders:manage server-side
  // (bulkUpdateOrderStatusAction), so gate that UI on manage — a view-only order
  // agent must not see controls that 403 on click.
  const canManage = permissionSetAllows(perms, "orders", "manage");
  const guestOnly = sp.guestOnly === "1" || sp.guestOnly === "true";
  const search = sp.q?.trim() || undefined;
  const phone = sp.phone?.trim() || undefined;
  // Status chip / « À traiter » queue / « Retours » are SERVER filters (URL
  // driven) so an order older than the loaded page is still reachable — they
  // used to filter only the 50 newest rows in the browser. A status chip and the
  // queue are mutually exclusive (the chip wins); Retours combines with either.
  const status = ORDER_STATUSES.includes(sp.status as OrderStatus)
    ? (sp.status as OrderStatus)
    : undefined;
  // « Spam » scope: shows ONLY flagged-spam orders (default view hides them). It is
  // mutually exclusive with the « À traiter » queue (spam is never actionable).
  const spamOnly = sp.spam === "1";
  const actionable = !status && !spamOnly && sp.actionable === "1";
  const returnsOnly = sp.returns === "1";
  // « Origine / Canal » — a server filter (combines with any status/queue scope).
  const channel = ORDER_CHANNELS.includes(sp.channel as OrderChannel)
    ? (sp.channel as OrderChannel)
    : undefined;
  // « Source » — marketing acquisition origin (migration 0198). A server filter,
  // validated against the known list so a junk query can't reach the WHERE.
  const source =
    sp.source && (ORDER_SOURCE_VALUES as readonly string[]).includes(sp.source)
      ? sp.source
      : undefined;
  const cursor = sp.cursor?.trim() || undefined;

  const [{ items, nextCursor }, stats, counts] = await Promise.all([
    orderService.list({
      limit: PAGE_SIZE,
      guestOnly,
      search,
      phone,
      status,
      actionable,
      hasReturn: returnsOnly,
      spam: spamOnly,
      channel,
      source,
      cursor,
    }),
    orderService.stats(),
    // Chip counts over the whole store (same guest/search base), not the page.
    orderService.listFilterCounts({ guestOnly, search, phone }),
  ]);
  // Flag rows that have a return (SAV) so the list surfaces retours — one
  // batched query over the page's order ids.
  // The fulfilment + refund aggregates power the L1 derived badges (partial
  // shipment / partial-or-full refund) — all batched over the page's ids.
  const orderIds = items.map((o) => o.id);
  const [returnIds, refundedByOrder, shippedByOrder, shippableByOrder, productSummary] = await Promise.all([
    returnService.orderIdsWithReturns(orderIds).catch(() => new Set<string>()),
    orderService.refundedByOrder(orderIds).catch(() => new Map<string, number>()),
    orderService.shippedQtyByOrder(orderIds).catch(() => new Map<string, number>()),
    orderService.shippableOrderedByOrder(orderIds).catch(() => new Map<string, number>()),
    orderService
      .productSummaryByOrder(orderIds)
      .catch(() => new Map<string, { firstName: string; lineCount: number; totalQty: number }>()),
  ]);

  // Pager links keep every active filter and only move the cursor.
  const pageHref = (c: string | null) => {
    const p = new URLSearchParams();
    if (search) p.set("q", search);
    if (phone) p.set("phone", phone);
    if (guestOnly) p.set("guestOnly", "1");
    if (status) p.set("status", status);
    if (actionable) p.set("actionable", "1");
    if (returnsOnly) p.set("returns", "1");
    if (spamOnly) p.set("spam", "1");
    if (channel) p.set("channel", channel);
    if (source) p.set("source", source);
    if (c) p.set("cursor", c);
    const qs = p.toString();
    return qs ? `/admin/orders?${qs}` : "/admin/orders";
  };

  return (
    <div className="space-y-6">
      <OrdersPanel
        stats={stats}
        counts={counts}
        filters={{ status: status ?? null, actionable, returns: returnsOnly, spam: spamOnly, channel: channel ?? null, source: source ?? null }}
        guestOnly={guestOnly}
        canCreateOrder={canCreateOrder}
        canManage={canManage}
        currentSearch={search ?? ""}
        currentPhone={phone ?? ""}
        orders={items.map((o) => ({
          id: o.id,
          orderNumber: o.order_number,
          userId: o.user_id,
          contactEmail: o.contact_email,
          contactPhone: o.contact_phone,
          isGuest: o.user_id == null,
          status: o.status,
          paymentMethod: o.payment_method,
          deliveryMethod: o.delivery_method,
          totalCents: o.total_cents,
          currency: o.currency,
          invoiceIssued: o.invoice_number != null,
          hasReturn: returnIds.has(o.id),
          fulfilmentBadge: deriveFulfilmentBadge(
            shippableByOrder.get(o.id) ?? 0,
            shippedByOrder.get(o.id) ?? 0,
          ),
          // Refund badge keys on the order total, matching the detail page +
          // refund workflow.
          refundBadge: deriveRefundBadge(o.total_cents, refundedByOrder.get(o.id) ?? 0),
          createdAt: o.created_at.toISOString(),
          paidAt: o.paid_at?.toISOString() ?? null,
          flaggedSpam: o.flagged_spam_at != null,
          channel: o.channel,
          source: o.source,
          productSummary: productSummary.get(o.id) ?? null,
        }))}
      />

      {(cursor || nextCursor) && (
        <nav className="flex items-center justify-between gap-3" aria-label="Pagination des commandes">
          {cursor ? (
            <Link
              href={pageHref(null)}
              className="inline-flex h-9 items-center rounded-full border border-border bg-card px-4 text-[12px] font-semibold text-foreground hover:bg-surface"
            >
              ← Commandes les plus récentes
            </Link>
          ) : (
            <span />
          )}
          {nextCursor && (
            <Link
              href={pageHref(nextCursor)}
              className="inline-flex h-9 items-center rounded-full bg-foreground px-4 text-[12px] font-semibold text-background"
            >
              Page suivante →
            </Link>
          )}
        </nav>
      )}
    </div>
  );
}
