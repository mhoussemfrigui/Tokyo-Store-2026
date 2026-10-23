import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { DELIVERY_METHOD_LABELS } from "@/lib/checkout/delivery-method-labels";
import { ORDER_CHANNEL_LABELS } from "@/lib/order/channel-labels";
import { orderSourceLabel } from "@/lib/order/order-source";
import {
  ChevronLeft,
  ClipboardCheck,
  CreditCard,
  ExternalLink,
  Info,
  LayoutGrid,
  MapPin,
  Phone,
  Printer,
  ReceiptText,
  ShieldAlert,
  User,
} from "lucide-react";

import { authQueries } from "@/modules/auth";
import { authService } from "@/modules/auth/service";
import { customerService } from "@/modules/customer/service";
import { customerUserLink } from "@/associations/customer-user.service";
import {
  findOrderById,
  getUserOrderSummary,
  listItemsForOrder,
  listStatusHistory,
} from "@/modules/order/queries";
import { CustomerHistoryCard } from "./customer-history-card";
import { orderService } from "@/modules/order/service";
import { requirePermission } from "@/lib/auth/session";
import { resolveUserPermissions, permissionSetAllows } from "@/lib/rbac/authorize";
import { computeOrderLineWarranty } from "@/lib/warranty";
import { formatMoneyExact } from "@/lib/price";
import { getTaxConfig } from "@/lib/tax";
import {
  isUpfrontPaidMethod,
  orderStatusLabel,
  orderStatusLabelFor,
  orderStatusColor,
  paymentMethodLabel,
} from "@/lib/order/status";
import {
  deriveFulfilmentBadge,
  deriveRefundBadge,
  FULFILMENT_BADGE_LABELS,
  FULFILMENT_BADGE_COLORS,
  REFUND_BADGE_LABELS,
  REFUND_BADGE_COLORS,
} from "@/lib/order/badges";
import { deriveReturnRefundAdvisory } from "@/lib/order/return-refund-advisory";
import {
  goodsLeftWarehouse,
  isFullyRefunded,
  returnBlockedByRefundRestock,
  sumRefundCents,
} from "@/lib/order/fulfilment-state";
import { isPaymentMethodEditable } from "@/workflows/order/set-payment-reference";
import { orderChargesTaxOnTop } from "@/workflows/order/set-invoice-tax";
import { orderTaxIncludedInTotal } from "@/lib/order/order-tax-mode";
import { RETURNABLE_STATUSES } from "@/workflows/order/returns";
import { isUuid } from "@/lib/utils/uuid";
import { returnService } from "@/modules/order/returns.service";
import { OrderStatusControls } from "./order-status-controls";
import { PreorderConvertControl } from "./preorder-convert-control";
import { VerificationPanel } from "./verification-panel";
import { DocumentsPanel } from "./documents-panel";
import { OrderLineEditor } from "./order-line-editor";
import { ShipmentsPanel } from "./shipments-panel";
import { PartialRefundForm } from "./partial-refund-form";
import { ReturnsPanel } from "./returns-panel";
import { ShipmentFailurePanel } from "./shipment-failure-panel";
import { GuestOrderLink } from "./guest-order-link";
import { PaymentReferenceForm } from "./payment-reference-form";
import { PaymentStatusForm } from "./payment-status-form";
import { isManualPaymentEnabled } from "@/lib/order/manual-payment-config";
import { getPriceDecimals } from "@/lib/price-format";
import { amountReceivedCents, paymentStateOf } from "@/lib/order/payment-status";
import { SwitchToCodButton } from "./switch-to-cod-button";
import { SpamControl } from "./spam-control";
import { isOnlineMethod } from "@/lib/payments/shared";
import { InvoiceTaxForm } from "./invoice-tax-form";
import { OrderDetailTabs, type OrderTab } from "./order-detail-tabs";
import { OrderTransfersPanel } from "./order-transfers-panel";
import { stockTransferService } from "@/modules/stock-transfer";
import { promotionService } from "@/modules/promotion";
import { AppliedPromosCard } from "./applied-promos-card";

export const metadata: Metadata = { title: "Détail commande" };

// Exact money — operator-facing figures match the charged total to the millime.
const formatTnd = (cents: number) => formatMoneyExact(cents);

/** Delivery-method labels (FR), keyed by the order's `delivery_method` column. */

export default async function OrderDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await requirePermission("orders", "view");
  if (!isUuid(id)) notFound();

  // Permissions + the order are independent reads — fetch in parallel.
  // Mutation controls render only for operators who can actually use them — a
  // view-only operator otherwise sees fully-enabled buttons that error on submit.
  const [perms, order] = await Promise.all([
    resolveUserPermissions(session.user.id),
    findOrderById(id),
  ]);
  if (!order) notFound();
  const canManage = permissionSetAllows(perms, "orders", "manage");
  const canUpdate = canManage || permissionSetAllows(perms, "orders", "update");
  // The returns actions accept returns:manage OR orders:manage (a scoped
  // « agent retours » role) — the panel honours the same pair, else that grant
  // would be unusable (this page is the only returns UI).
  const canManageReturns = canManage || permissionSetAllows(perms, "returns", "manage");

  const [items, history, refunds, taxConfig, orderReturns, returnedByItem, manualPaymentEnabled, priceDecimals] =
    await Promise.all([
      listItemsForOrder(order.id),
      listStatusHistory(order.id),
      orderService.listRefunds(order.id),
      getTaxConfig(),
      returnService.listForOrder(order.id).catch(() => []),
      returnService.returnedQtyByOrderItem(order.id).catch(() => new Map<string, number>()),
      // « Paiement manuel » — the control + its action are gated on this setting.
      isManualPaymentEnabled(),
      getPriceDecimals().catch(() => 0),
    ]);

  // Stock transfers linked to this order (auto-requested store→depot moves). Empty
  // for a single-pool store — the panel then renders nothing.
  const orderTransfers = await stockTransferService.listForOrder(order.id).catch(() => []);


  // Applied-promotions breakdown — net out reversals (a full refund/cancel frees
  // the slot), aggregate per promotion, resolve the label (coupon code, else the
  // promo name). Surfaces WHICH promotions gave the order's discount.
  const promoRedemptions = canManage
    ? await promotionService.listRedemptionsForOrder(order.id).catch(() => [])
    : [];
  const promoAgg = new Map<
    string,
    { promotionId: string; code: string | null; discount: number; ship: number; freeShip: boolean }
  >();
  for (const r of promoRedemptions) {
    const key = `${r.promotion_id}|${r.code_used ?? ""}`;
    const cur = promoAgg.get(key) ?? { promotionId: r.promotion_id, code: r.code_used, discount: 0, ship: 0, freeShip: false };
    cur.discount += r.discount_cents;
    cur.ship += r.shipping_waived_cents;
    cur.freeShip = cur.freeShip || r.free_shipping;
    promoAgg.set(key, cur);
  }
  const appliedPromos = await Promise.all(
    [...promoAgg.values()]
      .filter((p) => p.discount > 0 || p.ship > 0) // drop fully-reversed / no-visible-effect
      .map(async (p) => ({
        label: p.code ?? (await promotionService.findById(p.promotionId).catch(() => null))?.name ?? "Promotion",
        isCode: p.code != null,
        discountCents: p.discount,
        shippingWaivedCents: p.ship,
        freeShipping: p.freeShip,
      })),
  );

  // Returns (retours) panel data: returnable lines + existing returns with
  // their line names resolved from the order snapshot. Mirror the server guard
  // in createReturnWorkflow: only PHYSICALLY-SHIPPED units are returnable, so a
  // line's ceiling is its SHIPPED qty when the order has shipment records, else
  // the ordered qty (marked-delivered-without-BL fallback).
  const shippedByItem = await orderService.shippedQtyByItem(order.id).catch(() => new Map<string, number>());
  const hasShipments = shippedByItem.size > 0;
  // Refund LEDGER (not a manually-set 'refunded' status) drives every refund
  // gate on this page — same predicates as the workflows (fulfilment-state).
  const refundedTotalCents = sumRefundCents(refunds);
  // "Fully refunded" gates key on the order total — matching refund-order.ts.
  const refundCeilingCents = order.total_cents;
  const fullyRefunded = isFullyRefunded(refundCeilingCents, refundedTotalCents);
  // Mirror createReturnWorkflow: goods that never left the warehouse (history-
  // based — a paid→refunded order never shipped) can't be returned at all.
  const goodsLeft = await goodsLeftWarehouse(order).catch(() => true);
  // …and a shipment-less order whose FULL refund really restocked it (goods
  // never left, or `refund` restock rows) → nothing is returnable. A full refund
  // of goods that left without a BL restocked nothing, so those units stay
  // returnable (the return is how they get back to stock).
  const returnsBlocked = await returnBlockedByRefundRestock(order, {
    hasShipments,
    refundedCents: refundedTotalCents,
  }).catch(() => false);
  const itemNameById = new Map(items.map((i) => [i.id, i] as const));
  // createReturnWorkflow only accepts shipped / delivered / refunded orders —
  // same single source, so a pending / paid / preparing / cancelled order never
  // shows a create form that can only fail.
  const statusAllowsReturn = RETURNABLE_STATUSES.has(order.status);
  const returnableItems = !statusAllowsReturn || !goodsLeft || returnsBlocked
    ? []
    : items
        .map((i) => ({
          orderItemId: i.id,
          name: i.product_name,
          variantLabel: i.variant_label ?? null,
          remaining:
            (hasShipments ? (shippedByItem.get(i.id) ?? 0) : i.quantity) -
            (returnedByItem.get(i.id) ?? 0),
        }))
        .filter((i) => i.remaining > 0);
  const returnItemsByReturn = await returnService
    .listItemsForReturns(orderReturns.map((r) => r.id))
    .catch(() => new Map<string, Awaited<ReturnType<typeof returnService.listItems>>>());
  const returnsView = orderReturns.map((r) => ({
    id: r.id,
    kind: r.kind === "shipment" ? ("shipment" as const) : ("after_sale" as const),
    status: r.status,
    reasonCode: r.reason_code,
    reason: r.reason,
    comment: r.comment,
    carrierName: r.carrier_name,
    trackingRef: r.tracking_ref,
    deliveryAttempts: r.delivery_attempts,
    createdAt: r.created_at ? r.created_at.toISOString() : "",
    items: (returnItemsByReturn.get(r.id) ?? []).map((it) => ({
      name: itemNameById.get(it.order_item_id)?.product_name ?? "Article",
      quantity: it.quantity,
      restockable: it.restockable,
      restocked: it.restocked_at != null,
      conditionNote: it.condition_note,
    })),
  }));

  // Invoice TVA — the manual override wins over the computed snapshot. Drives
  // both the totals row below and the "TVA facture" control in the sidebar.
  const effectiveTaxCents = order.tax_manual_cents ?? order.tax_cents;
  const taxIsManual = order.tax_manual_cents != null;
  // Whether the tax was ADDED on top ("ht" → its own line summing into the
  // total) or already INCLUDED ("ttc" → an informational "dont TVA" note that
  // does NOT change the total). Inferred from the order's own arithmetic so it
  // stays correct even if the admin later flips the tax mode — mirrors the
  // customer confirmation page so all three surfaces agree.
  const taxIncludedInTotal = orderTaxIncludedInTotal(order);
  // Articles-header subtotal suffix, by the ORDER's inferred mode (the same rule
  // as the « TVA facture » control): HT only when the TVA is charged on top, TTC
  // when the prices included it, nothing when the order carries no TVA under a
  // disabled store (it's neither).
  const subtotalTaxSuffix = orderChargesTaxOnTop(order, taxConfig.mode)
    ? " HT"
    : effectiveTaxCents > 0 || taxConfig.mode === "ttc"
      ? " TTC"
      : "";

  // Operator preparation checklist — per-line pick status, shown only while
  // shipping is still ahead (pre-ship states).
  const preShip = order.status === "pending" || order.status === "paid" || order.status === "preparing";
  const pickLines =
    preShip && items.length > 0
      ? items.map((it) => ({
          orderItemId: it.id,
          productName: it.product_name,
          quantity: it.quantity,
          picked: it.picked_at != null,
        }))
      : null;

  // Operator line editing (pre-ship, before an invoice is issued) + partial
  // shipments. shippedByItem (computed above for the returns ceiling) bounds
  // both (a line can't drop below shipped). A FULLY refunded order is locked for
  // both (edit-items / create-shipment refuse it): the refund already restocked
  // its unshipped units, so editing or shipping them would double-count stock.
  const invoiceLocked = order.invoice_number != null || order.credit_note_number != null;
  const canEditLines = canManage && preShip && !invoiceLocked && !fullyRefunded && items.length > 0;
  const shippable =
    !fullyRefunded &&
    (order.status === "paid" || order.status === "preparing" || order.status === "shipped");
  // Fully refunded while still pre-ship: explain why editing/shipping vanished —
  // and, when nothing ever left, that the order can no longer move forward
  // (transition-status refuses it) and should be cancelled / marked refunded.
  const refundLockNote =
    canManage && fullyRefunded && preShip
      ? goodsLeft
        ?"Commande intégralement remboursée — le stock non expédié a déjà été réintégré : modification des lignes et nouvelles expéditions sont bloquées."
        : "Commande intégralement remboursée avant expédition — son stock a déjà été réintégré. Elle ne peut plus être modifiée, expédiée ni avancer : annulez-la ou marquez-la « Remboursée »."
      : null;
  const orderShipments = canManage ? await orderService.listShipments(order.id).catch(() => []) : [];
  const shipmentViews = await Promise.all(
    orderShipments.map(async (s) => {
      const sLines = await orderService.listShipmentItemsWithLines(s.id).catch(() => []);
      return {
        id: s.id,
        number: s.delivery_note_number,
        createdAt: (s.shipped_at ?? s.created_at).toISOString(),
        tracking: s.tracking_ref,
        lines: sLines.map((x) => ({ name: x.line.product_name, qty: x.quantity })),
      };
    }),
  );
  const showShipments = canManage && (shippable || orderShipments.length > 0) && items.length > 0;
  // Whole-order BL « Émettre » is withheld (issueDeliveryNoteAction refuses the
  // same cases) when parcels already carry their own BL numbers, or when a full
  // refund before shipping already put the stock back.
  const deliveryNoteBlockedReason =
    orderShipments.length > 0 || hasShipments
      ? "Bons de livraison émis par colis (voir Expéditions)."
      : fullyRefunded && !goodsLeft
        ? "Commande intégralement remboursée avant expédition — aucun bon de livraison à émettre."
        : null;

  const alreadyRefundedCents = refundedTotalCents;

  // L1 derived header badges (additive to order.status): a partial physical
  // shipment in progress, and a partial/full refund a non-`refunded` status hides.
  const [shippableOrderedQty, shippedTotalQty] = await Promise.all([
    orderService
      .shippableOrderedByOrder([order.id])
      .then((m) => m.get(order.id) ?? 0)
      .catch(() => 0),
    orderService
      .shippedQtyByOrder([order.id])
      .then((m) => m.get(order.id) ?? 0)
      .catch(() => 0),
  ]);
  const fulfilmentBadge = deriveFulfilmentBadge(shippableOrderedQty, shippedTotalQty);
  const refundBadge = deriveRefundBadge(refundCeilingCents, alreadyRefundedCents);

  // L12: return↔refund advisory — returns + refunds are decoupled, so nudge the
  // operator when the two sides are out of step (goods received but no refund, etc.).
  const returnRefundAdvisory = deriveReturnRefundAdvisory({
    receivedReturnCount: orderReturns.filter((r) => r.status === "received").length,
    pendingReturnCount: orderReturns.filter((r) => r.status === "pending").length,
    refundedCents: alreadyRefundedCents,
  });
  // Only an order with SETTLED money is refundable: `paid_at` is stamped at
  // payment (online) or at delivery (COD). A COD order in `shipped` has collected
  // no cash yet (paid_at null), so it must be CANCELLED (which restocks), not
  // refunded — the refund workflow enforces the same paid_at gate server-side.
  // An order already marked `refunded` after a PARTIAL refund keeps the form
  // while a balance remains, so the remainder can still be refunded here.
  const refundableStatuses = new Set(["paid", "shipped", "delivered"]);
  const canRefund =
    (refundableStatuses.has(order.status) ||
      (order.status === "refunded" && refundedTotalCents < refundCeilingCents)) &&
    order.paid_at != null;

  // Resolve the linked customer profile (if any) so we can deep-link from
  // the customer card.
  const customerLink = order.user_id
    ? await customerUserLink.findByUserId(order.user_id)
    : null;

  // « Historique client » insight — this customer's order history (account +
  // same-email guest checkouts), so the operator sees repeat/VIP vs first-timer.
  const customerSummary = canManage
    ? await getUserOrderSummary(order.user_id, order.contact_email).catch(() => null)
    : null;

  // Guest-order linking — when the order has no account (`user_id IS NULL`),
  // find a candidate account to attach it to. We match on the contact email
  // (the same identifier the self-service `claimGuestOrders` treats as the
  // security gate). The resolved user is enriched with its customer profile so
  // the operator sees a name + can tell from the phone whether it's the right
  // person before linking.
  type LinkCandidate = {
    userId: string;
    name: string;
    email: string;
    customerProfileId: string | null;
    profilePhone: string | null;
  };
  let linkCandidates: LinkCandidate[] = [];
  if (!order.user_id) {
    const byEmail = order.contact_email
      ? await authService.findByEmail(order.contact_email.trim())
      : null;
    if (byEmail) {
      const link = await customerUserLink.findByUserId(byEmail.id);
      const profile = link
        ? await customerService.findProfileById(link.customer_profile_id)
        : null;
      linkCandidates = [
        {
          userId: byEmail.id,
          name: byEmail.name,
          email: byEmail.email,
          customerProfileId: link?.customer_profile_id ?? null,
          profilePhone: profile?.phone ?? null,
        },
      ];
    }
  }

  // Batch-resolve the actors referenced in the history rows so the audit
  // trail shows names instead of hex slices.
  const actorIds = Array.from(
    new Set(history.map((h) => h.actor_user_id).filter((id): id is string => Boolean(id))),
  );
  const actorById = await authQueries.findUsersByIds(actorIds);

  // Which tabs to render. Commande + Historique are always present (read-only
  // content for view-only operators); Traitement (canManage) and Finances appear
  // only when the operator has controls to use, so a tab is never an empty shell.
  // Finances only when it has a usable control: the manage-gated controls
  // (payment ref / refund / paid date) OR — for an update-only operator — the
  // InvoiceTaxForm, which itself renders nothing when tax mode is "disabled"
  // (the default). Without the tax-mode check an update-only operator gets a
  // clickable tab that opens an empty panel.
  // A returns-only manager (returns:manage) also gets the tab — it holds the
  // ReturnsPanel (the payment controls inside stay gated on canManage).
  // The TVA tool stays usable on an order SOLD with TVA even after the store
  // turns TVA off (same gate as setOrderInvoiceTaxWorkflow).
  const invoiceTaxUsable =
    taxConfig.mode !== "disabled" || order.tax_cents > 0 || order.tax_manual_cents != null;
  const showPaiement = canManage || canManageReturns || (canUpdate && invoiceTaxUsable);

  // Warranty verdict inputs: coverage runs from the FIRST delivery (status
  // trail), else payment, else the order date — and a pending / cancelled /
  // refunded order reads « Non couverte » (computeOrderLineWarranty).
  const warrantyFacts = {
    status: order.status,
    createdAt: order.created_at,
    paidAt: order.paid_at,
    deliveredAt: history
      .filter((h) => h.to_status === "delivered")
      .reduce<Date | null>((first, h) => (!first || h.created_at < first ? h.created_at : first), null),
  };

  // ── Tab content blocks (built from the data above; the page only changes
  //    layout — RBAC gates + fetches are unchanged from the old sidebar) ──────

  const articlesCard = (
    <section className="rounded-[28px] border border-border bg-card">
      <header className="flex items-center justify-between border-b border-border p-4">
        <h2 className="inline-flex items-center gap-2 text-[18px] font-black tracking-[-0.02em] text-foreground">
          <ReceiptText className="h-4 w-4" /> Articles ({items.length})
        </h2>
        <span className="text-sm font-semibold">
          {formatTnd(order.subtotal_cents)}
          {subtotalTaxSuffix}
        </span>
      </header>
      {items.length === 0 ? (
        <p className="p-4 text-sm text-muted-foreground">
          Aucun article (commande sans contenu — étrange).
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {items.map((it) => (
            <li key={it.id} className="p-4">
              <div className="flex items-center gap-3">
                <span className="grid h-12 w-12 shrink-0 place-items-center overflow-hidden rounded-[14px] bg-surface">
                  {it.variant_image_url ?? it.product_image_url ? (
                    // Snapshot at order-time; admin keeps history even if catalog
                    // image is later replaced. The variant photo wins when the
                    // line carries one. Plain <img> by design (no next/image —
                    // host may be a stale or external URL).
                    <img
                      src={it.variant_image_url ?? it.product_image_url ?? undefined}
                      alt=""
                      className="h-full w-full object-cover"
                    />
                  ) : (
                    <span className="text-xs text-muted-foreground">—</span>
                  )}
                </span>
                <div className="min-w-0 flex-1">
                  <Link
                    href={`/${it.product_slug}`}
                    className="block truncate text-sm font-semibold text-foreground hover:underline"
                    target="_blank"
                  >
                    {it.product_name}
                  </Link>
                  {it.variant_label && (
                    <p className="text-[11px] font-medium text-foreground/80">
                      {it.variant_label}
                    </p>
                  )}
                  <p className="text-[11px] text-muted-foreground">
                    {it.variant_sku ?? it.product_sku ?? it.product_slug}
                  </p>
                  {/* Warranty snapshot frozen at checkout — green while
                      covered, red once expired, muted when the order owes
                      none (pending / cancelled / refunded), hidden when the
                      line had no warranty. Lets operators answer SAV
                      questions straight from the order. */}
                  {(() => {
                    const w = computeOrderLineWarranty(
                      warrantyFacts,
                      it.warranty_months ?? null,
                      it.warranty_label ?? null,
                    );
                    if (w.state === "none") return null;
                    return (
                      <p
                        className={`mt-0.5 text-[11px] font-medium ${
                          w.state === "active"
                            ? "text-[#15803d]"
                            : w.state === "expired"
                              ? "text-destructive"
                              : "text-muted-foreground"
                        }`}
                      >
                        {w.display}
                      </p>
                    );
                  })()}
                </div>
                <div className="shrink-0 text-right text-sm">
                  <p className="font-semibold">
                    {it.quantity} × {formatTnd(it.unit_price_cents)}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    = {formatTnd(it.subtotal_cents)}
                  </p>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      {/* Money totals */}
      <div className="grid gap-2 border-t border-border p-4 text-sm">
        <Row label="Sous-total" value={formatTnd(order.subtotal_cents)} />
        {order.shipping_cents > 0 && (
          <Row label="Livraison" value={formatTnd(order.shipping_cents)} />
        )}
        {order.care_cents > 0 && (
          <Row label="Tokyo Care (protection)" value={formatTnd(order.care_cents)} />
        )}
        {order.discount_cents > 0 && (
          <Row label="Remise" value={`− ${formatTnd(order.discount_cents)}`} />
        )}
        {effectiveTaxCents > 0 && !taxIncludedInTotal && (
          <Row
            label={`${taxConfig.label}${taxIsManual ? " (saisie)" : ""}`}
            value={formatTnd(effectiveTaxCents)}
          />
        )}
        <Row label="Total" value={formatTnd(order.total_cents)} bold />
        {effectiveTaxCents > 0 && taxIncludedInTotal && (
          <p className="pt-0.5 text-right text-[11px] text-muted-foreground">
            dont {taxConfig.label} {formatTnd(effectiveTaxCents)}
          </p>
        )}
        {order.paid_at && (
          <p className="pt-1 text-[11px] text-muted-foreground">
            Payée le{" "}
            {new Date(order.paid_at).toLocaleString("fr-FR", {
              dateStyle: "short",
              timeStyle: "short",
            })}
          </p>
        )}
      </div>
    </section>
  );

  const clientCard = (
    <section className="rounded-[28px] border border-border bg-card p-4">
      <h2 className="mb-3 flex items-center gap-2 text-[18px] font-black tracking-[-0.02em] text-foreground">
        <User className="h-4 w-4" /> Client
      </h2>
      <p className="text-sm font-medium">{order.contact_email}</p>
      {order.contact_phone && (
        <p className="flex w-fit items-center gap-1 text-[12px] text-muted-foreground">
          <Phone className="h-3 w-3" /> {order.contact_phone}
        </p>
      )}
      {customerLink ? (
        <Link
          href={`/admin/customers/${customerLink.customer_profile_id}`}
          className="mt-3 inline-flex h-9 items-center gap-1.5 rounded-full border-[1.5px] border-input bg-card px-3 text-[11px] font-bold text-foreground transition hover:bg-surface"
        >
          Voir le profil client
          <ExternalLink className="h-3 w-3" />
        </Link>
      ) : order.user_id ? (
        <p className="mt-2 text-[11px] text-muted-foreground">
          user_id: <code className="rounded bg-surface px-1 py-0.5">{order.user_id.slice(0, 16)}…</code>
        </p>
      ) : (
        <div className="mt-3 border-t border-border pt-3">
          <p className="mb-2 inline-flex rounded-full bg-surface px-2.5 py-1 text-[11px] font-semibold text-muted-foreground">
            Commande invitée
          </p>
          {linkCandidates.length === 0 ? (
            <p className="text-[11px] text-muted-foreground">
              Aucun compte correspondant à {order.contact_email}
              {order.contact_phone ? ` / ${order.contact_phone}` : ""}.
            </p>
          ) : !canManage ? (
            <p className="text-[11px] text-muted-foreground">
              Un compte correspondant existe — la liaison est réservée aux
              gestionnaires de commandes.
            </p>
          ) : (
            // One candidate per match. « Lier » calls linkGuestOrderAction and
            // shows its outcome (the workflow's guard refuses an order another
            // operator / a sign-up claim already linked — now visible).
            <GuestOrderLink
              orderId={order.id}
              candidates={linkCandidates.map((c) => ({
                userId: c.userId,
                name: c.name,
                email: c.email,
                profilePhone: c.profilePhone,
                // The order's contact phone aligns with the candidate's
                // profile phone — a confidence signal for the operator.
                phoneMatches:
                  !!order.contact_phone &&
                  !!c.profilePhone &&
                  order.contact_phone.replace(/\D/g, "") === c.profilePhone.replace(/\D/g, ""),
              }))}
            />
          )}
        </div>
      )}
    </section>
  );

  const livraisonCard = (
    <section className="rounded-[28px] border border-border bg-card p-4">
      <h2 className="mb-3 flex items-center gap-2 text-[18px] font-black tracking-[-0.02em] text-foreground">
        <MapPin className="h-4 w-4" /> Livraison
      </h2>
      {/* Delivery method + the agent / pickup-location snapshot frozen on
          the order at checkout. Agent/location lines render only when set. */}
      <p className="mb-2 inline-flex rounded-full bg-surface px-2.5 py-1 text-[11px] font-semibold text-foreground">
        {DELIVERY_METHOD_LABELS[order.delivery_method] ?? order.delivery_method}
      </p>
      {/* Origine / Canal — where the order came from (migration 0172), + the ERP
          link ref when it was pushed in by an external system. */}
      <p className="mb-2 text-[12px] text-muted-foreground">
        Origine : <span className="text-foreground">{ORDER_CHANNEL_LABELS[order.channel]}</span>
        {orderSourceLabel(order.source) ? (
          <>
            {" "}· Source : <span className="text-foreground">{orderSourceLabel(order.source)}</span>
          </>
        ) : null}
        {order.external_ref ? (
          <>
            {" "}· Réf. externe : <span className="font-mono text-foreground">{order.external_ref}</span>
          </>
        ) : null}
      </p>
      {order.delivery_agent_name && (
        <p className="text-[12px] text-muted-foreground">
          Livreur : <span className="text-foreground">{order.delivery_agent_name}</span>
        </p>
      )}
      {order.pickup_location_name && (
        <p className="mb-1 text-[12px] text-muted-foreground">
          Point de retrait :{" "}
          <span className="text-foreground">{order.pickup_location_name}</span>
          {order.pickup_location_address ? ` — ${order.pickup_location_address}` : ""}
        </p>
      )}
      <p className="text-sm font-medium">{order.ship_full_name}</p>
      <p className="text-sm text-muted-foreground">
        {order.ship_street_line1}
        {order.ship_street_line2 ? `, ${order.ship_street_line2}` : ""}
        <br />
        {order.ship_postal_code ? `${order.ship_postal_code} ` : ""}
        {order.ship_city}
        {order.ship_region ? `, ${order.ship_region}` : ""}
        <br />
        {order.ship_country}
      </p>
      {order.ship_phone && (
        <p className="mt-1 flex w-fit items-center gap-1 text-[12px] text-muted-foreground">
          <Phone className="h-3 w-3" /> {order.ship_phone}
        </p>
      )}
    </section>
  );

  const notesCard = order.notes ? (
    <section className="rounded-[28px] border border-border bg-card p-4">
      <h2 className="mb-2 text-[18px] font-black tracking-[-0.02em] text-foreground">Notes</h2>
      <p className="whitespace-pre-wrap text-sm text-muted-foreground">{order.notes}</p>
    </section>
  ) : null;

  const historyCard = (
    <section className="rounded-[28px] border border-border bg-card p-4">
      <h2 className="mb-3 text-[18px] font-black tracking-[-0.02em] text-foreground">Historique des statuts</h2>
      {history.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Pas de transitions enregistrées — la commande est restée dans son état initial.
        </p>
      ) : (
        <ol className="space-y-3">
          {history.map((h, i) => (
            <li key={h.id} className="flex gap-3">
              <div className="flex flex-col items-center">
                <span className="h-2.5 w-2.5 rounded-full bg-primary" />
                {i !== history.length - 1 && <span className="mt-1 h-full w-px bg-border" />}
              </div>
              <div className="pb-3 text-sm">
                <p className="font-medium">
                  {h.from_status
                    ? `${orderStatusLabel(h.from_status)} → ${orderStatusLabel(h.to_status)}`
                    : orderStatusLabel(h.to_status)}
                </p>
                <p className="text-[11px] text-muted-foreground">
                  {new Date(h.created_at).toLocaleString("fr-FR", {
                    dateStyle: "short",
                    timeStyle: "short",
                  })}
                  {h.actor_user_id
                    ? (() => {
                        const actor = actorById.get(h.actor_user_id);
                        return ` · acteur ${actor ? actor.name : `${h.actor_user_id.slice(0, 8)}…`}`;
                      })()
                    : " · système"}
                </p>
                {h.notes && (
                  <p className="mt-1 italic text-muted-foreground">“{h.notes}”</p>
                )}
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );

  // Plain-language primer for the fulfilment tab — operators don't always know
  // what "réintégration" means or that lowering a line restocks it.
  const prepIntro = (
    <div className="rounded-[14px] border border-dashed border-border bg-surface/40 p-4 text-xs leading-relaxed text-muted-foreground">
      <p className="font-semibold text-foreground">Préparer puis expédier</p>
      <p className="mt-1.5">
        Vérifiez chaque ligne, confirmez la préparation, puis créez un bon de livraison
        (total ou partiel).
      </p>
      <p className="mt-1.5">
        <strong>Réintégration</strong> = remettre des unités en stock vendable. Réduire la
        quantité d&apos;une ligne ou retirer une ligne réintègre automatiquement les unités
        concernées (impossible en dessous des unités déjà expédiées).
      </p>
    </div>
  );

  const tabs: OrderTab[] = [
    {
      id: "information",
      label: "Information",
      icon: <LayoutGrid className="h-3.5 w-3.5" />,
      // Read-only context to CHECK first — articles, client, livraison, notes, and
      // the status trail (folded in from the old « Historique » tab). Mirrors Game
      // Zone's 3-sub-tab order-detail (Information / Actions / Paiement & retours).
      content: (
        <>
          {articlesCard}
          <div className="grid gap-4 lg:grid-cols-2">
            {clientCard}
            {livraisonCard}
          </div>
          {customerSummary && (
            <CustomerHistoryCard
              summary={customerSummary}
              customerHref={customerLink ? `/admin/customers/${customerLink.customer_profile_id}` : null}
              currentOrderId={order.id}
            />
          )}
          {notesCard}
          {historyCard}
        </>
      ),
    },
    // TRAITEMENT — the fulfilment hub: confirm/advance the order + prepare + ship.
    // Gated by canManage (the status controls are always meaningful); the prep/
    // ship sections render only when there's an actionable step, so it's never
    // empty for an operator.
    ...(canManage
      ? [
          {
            id: "actions",
            label: "Actions",
            icon: <ClipboardCheck className="h-3.5 w-3.5" />,
            content: (
              <>
                <OrderStatusControls
                  orderId={order.id}
                  currentStatus={order.status}
                  paymentMethod={order.payment_method}
                  deliveryMethod={order.delivery_method}
                  confirmed={order.confirmed_at != null}
                  fullyRefunded={fullyRefunded}
                  isPaid={order.paid_at != null}
                />
                {refundLockNote && (
                  <AdvisoryNote advisory={{ level: "warn", message: refundLockNote }} />
                )}
                {/* Précommande release — consume reservations + decrement stock. */}
                {canManage && order.is_preorder && order.preorder_converted_at == null && (
                  <PreorderConvertControl orderId={order.id} releasesAt={null} />
                )}
                {/* Spam triage — flag junk orders out of the default list + queue. */}
                <SpamControl orderId={order.id} flaggedSpam={order.flagged_spam_at != null} />
                {/* The primer talks about preparing + creating a BL — only show
                    it when there's an actionable step (not a read-only shipment
                    history on a delivered order). */}
                {(pickLines || canEditLines || shippable) && prepIntro}
                {pickLines && <VerificationPanel orderId={order.id} lines={pickLines} />}
                {canEditLines && (
                  <OrderLineEditor
                    orderId={order.id}
                    lines={items.map((it) => ({
                      orderItemId: it.id,
                      name: it.product_name,
                      variantLabel: it.variant_label ?? null,
                      quantity: it.quantity,
                      unitPriceCents: it.unit_price_cents,
                      shippedQty: shippedByItem.get(it.id) ?? 0,
                    }))}
                  />
                )}
                {showShipments && (
                  <ShipmentsPanel
                    orderId={order.id}
                    canCompose={shippable}
                    lockedReason={
                      fullyRefunded
                        ? "Commande intégralement remboursée — aucune nouvelle expédition possible."
                        : null
                    }
                    shipments={shipmentViews}
                    lines={items.map((it) => ({
                      orderItemId: it.id,
                      name: it.product_name,
                      variantLabel: it.variant_label ?? null,
                      remaining: it.quantity - (shippedByItem.get(it.id) ?? 0),
                    }))}
                  />
                )}
                {/* Stock transfers auto-requested to fill this order (store→depot).
                    Renders nothing for a single-pool store. */}
                <OrderTransfersPanel transfers={orderTransfers} />
                {/* Bon de livraison — a FULFILMENT document (auto-issued on
                    shipment), so it lives here with the shipments, not in
                    Finances alongside the fiscal papers. */}
                <DocumentsPanel
                  orderId={order.id}
                  invoiceNumber={order.invoice_number}
                  creditNoteNumber={order.credit_note_number}
                  deliveryNoteNumber={order.delivery_note_number}
                  hasRefund={refunds.length > 0}
                  deliveryNoteBlockedReason={deliveryNoteBlockedReason}
                  scope="fulfilment"
                />
              </>
            ),
          } satisfies OrderTab,
        ]
      : []),
    // FINANCES — every money + document + SAV control on one screen, so a COD
    // order's "cancel-not-refund-until-delivered" reality and the TVA/refund
    // controls are all legible together (ends the cross-tab duplication).
    ...(showPaiement
      ? [
          {
            id: "money",
            label: "Paiement & retours",
            icon: <CreditCard className="h-3.5 w-3.5" />,
            content: (
              <>
                {/* Read-only settlement summary — method + paid/unpaid + the
                    reference, without reading the totals card. */}
                <section className="rounded-[28px] border border-border bg-card p-4 sm:p-5">
                  <h2 className="mb-3 inline-flex items-center gap-2 text-[18px] font-black tracking-[-0.02em] text-foreground">
                    <CreditCard className="h-4 w-4" /> Encaissement
                  </h2>
                  <dl className="space-y-2 text-sm">
                    <div className="flex items-center justify-between gap-3">
                      <dt className="text-muted-foreground">Méthode</dt>
                      <dd className="font-medium">{paymentMethodLabel(order.payment_method)}</dd>
                    </div>
                    <div className="flex items-center justify-between gap-3">
                      <dt className="text-muted-foreground">État</dt>
                      <dd>
                        {order.paid_at ? (
                          <span className="rounded-full bg-[#eaf7ee] px-2.5 py-0.5 text-[11px] font-semibold uppercase text-[#15803d]">
                            Payée le{" "}
                            {new Date(order.paid_at).toLocaleDateString("fr-FR", {
                              dateStyle: "short",
                            })}
                          </span>
                        ) : order.status === "pending" &&
                          isUpfrontPaidMethod(order.payment_method) ? (
                          <span className="rounded-full bg-[#fff4e0] px-2.5 py-0.5 text-[11px] font-semibold uppercase text-[#b45309]">
                            Paiement en ligne en attente
                          </span>
                        ) : (
                          <span className="rounded-full bg-[#f6f2ed] px-2.5 py-0.5 text-[11px] font-semibold uppercase text-[#5b5d62]">
                            Non réglée
                          </span>
                        )}
                      </dd>
                    </div>
                    {order.payment_reference && (
                      <div className="flex items-center justify-between gap-3">
                        <dt className="text-muted-foreground">Référence</dt>
                        <dd className="font-mono text-[13px] text-foreground/80">
                          {order.payment_reference}
                        </dd>
                      </div>
                    )}
                  </dl>
                  {/* Payment-timing explainer — states WHEN money is collected,
                      which differs by method: online is settled UPFRONT (one of
                      the first steps, before preparation); COD is collected at
                      delivery (the LAST step, so refunds only open up once
                      delivered). Shown only while still unsettled. */}
                  {order.paid_at == null &&
                    (isUpfrontPaidMethod(order.payment_method) ? (
                      <>
                        <p className="mt-3 rounded-[14px] border border-border bg-surface/50 px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
                          Paiement en ligne — réglé à la commande, avant la
                          préparation. En attente de confirmation du règlement.
                        </p>
                        {/* Rescue a stuck pending online order (payment never
                            completed): convert it to COD instead of letting the
                            abandoned-orders sweep cancel it. Only for a pending
                            ONLINE (gateway) order; the action re-checks fail-closed. */}
                        {canManage &&
                          order.status === "pending" &&
                          isOnlineMethod(order.payment_method) && (
                            <SwitchToCodButton orderId={order.id} />
                          )}
                      </>
                    ) : (
                      <p className="mt-3 rounded-[14px] border border-border bg-surface/50 px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
                        Paiement à la livraison — l&apos;encaissement et la
                        possibilité de remboursement interviennent une fois la
                        commande livrée.
                      </p>
                    ))}
                  <Link
                    href="/admin/system/payments"
                    className="mt-3 inline-block text-[11px] text-primary underline-offset-2 hover:underline"
                  >
                    Configurer les passerelles →
                  </Link>
                </section>
                {canManage && (
                  <PaymentReferenceForm
                    orderId={order.id}
                    currentMethod={order.payment_method}
                    currentReference={order.payment_reference}
                    methodLocked={!isPaymentMethodEditable(order)}
                  />
                )}
                {/* « Paiement manuel » — only when the admin enabled it
                    (Système → Paiement) and not on a terminal order. */}
                {canManage &&
                  manualPaymentEnabled &&
                  order.status !== "cancelled" &&
                  order.status !== "refunded" && (
                    <PaymentStatusForm
                      orderId={order.id}
                      currentState={paymentStateOf(order)}
                      receivedCents={amountReceivedCents(order)}
                      dueCents={order.total_cents}
                      decimals={priceDecimals}
                    />
                  )}
                {canUpdate && (
                  <InvoiceTaxForm
                    orderId={order.id}
                    effectiveTaxCents={effectiveTaxCents}
                    isManual={taxIsManual}
                    taxLabel={taxConfig.label}
                    disabled={!invoiceTaxUsable}
                    // Fiscal lock (same rule as line editing): once numbered,
                    // the printed TVA is read-only — the workflow refuses too.
                    lockedDocument={
                      invoiceLocked ? (order.invoice_number ?? order.credit_note_number) : null
                    }
                  />
                )}
                {/* Return ↔ refund advisory — rendered ONCE here (was duplicated
                    across the old Paiement + Retours tabs). */}
                {canManage && returnRefundAdvisory && (
                  <AdvisoryNote advisory={returnRefundAdvisory} />
                )}
                {canManage && canRefund && (
                  <PartialRefundForm
                    orderId={order.id}
                    /* Refundable ceiling = the order total. */
                    totalCents={refundCeilingCents}
                    alreadyRefundedCents={alreadyRefundedCents}
                  />
                )}
                {/* Which promotions gave this order's discount (netted for reversals). */}
                <AppliedPromosCard promos={appliedPromos} />
                {/* « Retour d'expédition » declaration — only a SHIPPED order's
                    parcel can bounce back undelivered (createReturnWorkflow gates
                    kind='shipment' to status==='shipped'). */}
                {canManageReturns && order.status === "shipped" && (
                  <ShipmentFailurePanel orderId={order.id} items={returnableItems} />
                )}
                {canManageReturns && (
                  <ReturnsPanel
                    orderId={order.id}
                    items={returnableItems}
                    returns={returnsView}
                    emptyMessage={
                      !statusAllowsReturn
                        ? `Retour possible uniquement pour une commande expédiée, livrée ou remboursée (statut actuel : ${orderStatusLabel(order.status)}).`
                        : !goodsLeft
                          ? "Aucun retour possible : les articles de cette commande ne sont pas sortis de l'entrepôt."
                          : returnsBlocked
                            ? "Aucun retour possible : le remboursement intégral a déjà réintégré le stock de cette commande."
                            : undefined
                    }
                  />
                )}
                {canManage && (
                  <DocumentsPanel
                    orderId={order.id}
                    invoiceNumber={order.invoice_number}
                    creditNoteNumber={order.credit_note_number}
                    deliveryNoteNumber={order.delivery_note_number}
                    hasRefund={refunds.length > 0}
                    scope="financial"
                  />
                )}
              </>
            ),
          } satisfies OrderTab,
        ]
      : []),
  ];

  return (
    <div className="space-y-5">
      <div>
        <Link
          href="/admin/orders"
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="h-3 w-3" /> Retour aux commandes
        </Link>
        <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-black tracking-[-0.02em] text-foreground sm:text-3xl">
              {order.order_number}
            </h1>
            <p className="mt-1.5 text-[14px] leading-relaxed text-muted-foreground">
              {new Date(order.created_at).toLocaleString("fr-FR", {
                dateStyle: "long",
                timeStyle: "short",
              })}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {/* Customer-facing view — public order page (works for guest +
                registered; shareable with the rider/customer). */}
            <Link
              href={`/order/${order.id}`}
              target="_blank"
              className="inline-flex h-9 items-center gap-1.5 rounded-full border-[1.5px] border-input bg-card px-3 text-[13px] font-bold text-foreground transition hover:bg-surface"
            >
              <ExternalLink className="h-3.5 w-3.5" /> Voir côté client
            </Link>
            <Link
              href={`/admin/orders/${order.id}/invoice?autoprint=1`}
              target="_blank"
              className="inline-flex h-9 items-center gap-1.5 rounded-full border-[1.5px] border-input bg-card px-3 text-[13px] font-bold text-foreground transition hover:bg-surface"
            >
              <Printer className="h-3.5 w-3.5" /> Imprimer facture
            </Link>
            <div className="flex flex-wrap items-center justify-end gap-1.5">
              <span
                className={`inline-flex items-center rounded-full px-3 py-1 text-[11px] font-bold ${orderStatusColor(order.status)}`}
              >
                {orderStatusLabelFor(order.status, order.delivery_method)}
              </span>
              {/* Spam marker — visible across every tab so a flagged order is never
                  actioned by mistake. */}
              {order.flagged_spam_at != null && (
                <span className="inline-flex items-center gap-1 rounded-full bg-[#fdecef] px-2.5 py-1 text-[11px] font-semibold uppercase text-[#d40530]">
                  <ShieldAlert className="h-3 w-3" /> Spam
                </span>
              )}
              {/* Derived badges (L1) — partial shipment in progress + a refund the
                  status doesn't already show. */}
              {fulfilmentBadge === "partial" && (
                <span
                  className={`rounded-full px-2.5 py-1 text-[11px] font-bold ${FULFILMENT_BADGE_COLORS.partial}`}
                >
                  {FULFILMENT_BADGE_LABELS.partial}
                </span>
              )}
              {/* Hide only the REDUNDANT "Remboursée" chip on a refunded order;
                  keep "Remboursement partiel" visible (status alone would hide
                  that money is still outstanding). */}
              {refundBadge !== "none" &&
                !(order.status === "refunded" && refundBadge === "full") && (
                  <span
                    className={`rounded-full px-2.5 py-1 text-[11px] font-bold ${REFUND_BADGE_COLORS[refundBadge]}`}
                  >
                    {REFUND_BADGE_LABELS[refundBadge]}
                  </span>
                )}
            </div>
          </div>
        </div>
      </div>

      <OrderDetailTabs tabs={tabs} />
    </div>
  );
}

/** L12 return↔refund advisory card — amber for "warn", muted for "info". */
function AdvisoryNote({
  advisory,
}: {
  advisory: { level: "warn" | "info"; message: string };
}) {
  const warn = advisory.level === "warn";
  return (
    <div
      className={`flex items-start gap-2 rounded-[14px] border px-4 py-3 text-xs leading-relaxed ${
        warn
          ? "border-[#f3e3bd] bg-[#fff4e0] text-[#b45309]"
          : "border-border bg-surface text-muted-foreground"
      }`}
    >
      <Info className={`mt-0.5 h-4 w-4 shrink-0 ${warn ? "text-[#b45309]" : "text-muted-foreground"}`} />
      <p>{advisory.message}</p>
    </div>
  );
}

function Row({
  label,
  value,
  bold,
}: {
  label: string;
  value: string;
  bold?: boolean;
}) {
  return (
    <div
      className={`flex items-center justify-between ${bold ? "border-t border-border pt-2" : ""}`}
    >
      <span className={bold ? "font-semibold" : "text-muted-foreground"}>
        {label}
      </span>
      <span className={bold ? "font-bold text-foreground" : ""}>{value}</span>
    </div>
  );
}
