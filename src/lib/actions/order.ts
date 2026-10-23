"use server";

import { revalidatePath } from "next/cache";
import { cookies, headers } from "next/headers";
import { z } from "zod";

import { workflows } from "@/workflows";
import { requirePermission, requirePermissionAny, getSession } from "@/lib/auth/session";
import { isOnlineMethod } from "@/lib/payments/gateway";
import {
  assertPendingOnlineOrderNotCaptured,
  settleZeroTotalOrderWorkflow,
} from "@/workflows/order/gateway-payment";
import { checkRateLimit } from "@/lib/rate-limit";
import { getClientIp } from "@/lib/client-ip";
import { isUuid } from "@/lib/utils/uuid";
import { isManualPaymentEnabled } from "@/lib/order/manual-payment-config";
import { getQuickBuyConfig, resolvePaymentMethod } from "@/lib/checkout/quick-buy-config";
import {
  checkOrderPlacementRateLimit,
  ORDER_RATE_LIMITED_MESSAGE,
  recordOrderPlaced,
  resolveOrderContactEmail,
} from "@/lib/checkout/place-order-guards";
import { readCart, resolveCart } from "@/lib/cart/session";
import { readCartPromotionCandidates, resolveAppliedCartPromotion } from "@/lib/cart/coupon";
import { couponLinesOf, priceCartLinesLive } from "@/lib/cart/live-lines";
import { cartService } from "@/modules/cart/service";
import { orderService } from "@/modules/order/service";
import { findOrderById, findOrdersByIds, findOrderByNumber } from "@/modules/order/queries";
import { dinarsToMinor } from "@/lib/price";
import { type ActionState } from "@/lib/actions/types";

/**
 * Place-order actions return the new order's identifiers so the client
 * can navigate to `/order/<id>` without a follow-up round-trip. Extends
 * the shared {@link ActionState} via intersection rather than redefining it.
 */
type PlaceOrderActionState = ActionState & {
  orderId?: string;
  orderNumber?: string;
  /** Online payment methods only: where the client redirects the customer to
   *  complete payment at the gateway. Absent for COD or if init failed. */
  redirectUrl?: string;
};

/**
 * Fail-closed pre-flight before any pending-online cancel (admin dropdown, bulk,
 * or customer « Annuler »). Verifies the gateway and refuses the cancel when the
 * order is (or might be) actually paid — otherwise a paid-but-unsettled online
 * order would be cancelled with the money kept and loyalty/coins/promos reversed +
 * stock restocked. Returns an error ActionState to short-circuit, or null to proceed.
 */
async function guardPendingOnlineCancel(
  orderId: string,
  actorUserId: string | null,
): Promise<ActionState | null> {
  const order = await findOrderById(orderId);
  // Non-pending is handled by the status graph; only a pending order can hold an
  // unsettled online capture.
  if (!order || order.status !== "pending") return null;
  const safety = await assertPendingOnlineOrderNotCaptured(order, { actorUserId });
  if (!safety.ok) return { ok: false, error: safety.error, message: safety.message };
  return null;
}

/**
 * Start the online payment of a pending ONLINE order: create the gateway session
 * and return its redirect URL. A ZERO-total order (100 % coupon, coins covering
 * the rest…) has nothing to charge — `initiatePayment` refuses it with
 * `zero_amount` (the gateways reject a 0 amount) — so it is settled on the spot
 * instead (→ `paid`, reference "zero-total") and no redirect URL is returned.
 */
async function startOnlinePayment(
  orderId: string,
  actorUserId: string | null,
): Promise<{ ok: true; redirectUrl?: string } | { ok: false; error: string; message: string }> {
  const init = await workflows.order.initiatePayment({ orderId }, { actorUserId });
  if (init.ok) return { ok: true, redirectUrl: init.data.redirectUrl };
  if (init.error === "zero_amount") {
    const settled = await settleZeroTotalOrderWorkflow({ orderId }, { actorUserId });
    if (settled.ok) return { ok: true };
    return { ok: false, error: settled.error, message: settled.message };
  }
  return { ok: false, error: init.error, message: init.message };
}

export async function transitionOrderStatusAction(
  orderId: string,
  toStatus: "pending" | "paid" | "preparing" | "shipped" | "delivered" | "cancelled" | "refunded",
): Promise<ActionState> {
  const session = await requirePermission("orders", "manage");
  if (toStatus === "cancelled") {
    const blocked = await guardPendingOnlineCancel(orderId, session.user.id);
    if (blocked) return blocked;
  }
  const result = await workflows.order.transitionStatus(
    { orderId, toStatus },
    { actorUserId: session.user.id },
  );
  if (!result.ok) return { ok: false, error: result.error, message: result.message };
  // Revalidate the DETAIL page too (not just the list) so a subsequent
  // navigation to it — and the client router.refresh() after this action —
  // read the new status, matching every sibling order action.
  revalidatePath(`/admin/orders/${orderId}`);
  revalidatePath("/admin/orders");
  return { ok: true };
}

/**
 * « Paiement manuel » — set an order's payment state (paid / partial / unpaid)
 * directly, for offline settlements the gateway/COD flow doesn't capture.
 * DOUBLE-gated: the `orders.manual_payment_enabled` setting must be ON (checked
 * here, not just hidden in the UI) AND the actor needs `orders:manage`. Marking
 * paid runs the normal settlement (revenue via `order.paid`); un-settling
 * reverses it.
 */
export async function setOrderPaymentStatusAction(input: {
  orderId: string;
  state: "unpaid" | "partial" | "paid";
  /** Amount received in minor units — only used for `partial`. */
  amountCents?: number;
}): Promise<ActionState> {
  const session = await requirePermission("orders", "manage");
  if (!(await isManualPaymentEnabled())) {
    return {
      ok: false,
      error: "disabled",
      message: "Le paiement manuel n'est pas activé (Système → Paiement).",
    };
  }
  const res = await workflows.order.setPaymentStatus(input, { actorUserId: session.user.id });
  if (!res.ok) return { ok: false, error: res.error, message: res.message };
  revalidatePath(`/admin/orders/${input.orderId}`);
  revalidatePath("/admin/orders");
  return { ok: true, message: "Paiement mis à jour." };
}

/**
 * Operator "Confirmer la commande" — accept a placed order (mainly COD; online
 * orders auto-confirm on payment). Stamps confirmed_at + fires the confirmation
 * email, without changing the status.
 */
export async function confirmOrderAction(orderId: string): Promise<ActionState> {
  const session = await requirePermission("orders", "manage");
  const result = await workflows.order.confirm({ orderId }, { actorUserId: session.user.id });
  if (!result.ok) return { ok: false, error: result.error, message: result.message };
  revalidatePath(`/admin/orders/${orderId}`);
  revalidatePath("/admin/orders");
  return { ok: true };
}

/**
 * Operator order-line editing — add / change-qty / remove lines on a pre-ship
 * order, reconciling stock + tax + totals atomically (see editOrderItemsWorkflow).
 */
export async function editOrderItemsAction(input: {
  orderId: string;
  ops: Array<
    | { kind: "add"; productId: string; variantId?: string | null; quantity: number }
    | { kind: "set_qty"; orderItemId: string; quantity: number }
    | { kind: "remove"; orderItemId: string }
  >;
}): Promise<ActionState> {
  const session = await requirePermission("orders", "manage");
  const res = await workflows.order.editItems(input, { actorUserId: session.user.id });
  if (!res.ok) return { ok: false, error: res.error, message: res.message };
  revalidatePath(`/admin/orders/${input.orderId}`);
  revalidatePath(`/admin/orders/${input.orderId}/invoice`);
  revalidatePath("/admin/orders");
  return { ok: true, message: "Commande mise à jour." };
}

/**
 * Create a partial-shipment bon de livraison (a parcel covering a subset of line
 * quantities). Returns the BL id so the client can open it for printing.
 */
export async function createShipmentAction(input: {
  orderId: string;
  lines: Array<{ orderItemId: string; quantity: number }>;
  deliveryMethod?: "home_delivery" | "drive_by_pickup" | "in_store" | null;
  deliveryAgentName?: string;
  trackingRef?: string;
  notes?: string;
  markShipped?: boolean;
}): Promise<ActionState & { shipmentId?: string; deliveryNoteNumber?: string }> {
  const session = await requirePermission("orders", "manage");
  const res = await workflows.order.createShipment(input, { actorUserId: session.user.id });
  if (!res.ok) return { ok: false, error: res.error, message: res.message };
  revalidatePath(`/admin/orders/${input.orderId}`);
  revalidatePath("/admin/orders");
  return {
    ok: true,
    message: `Bon de livraison ${res.data.deliveryNoteNumber} créé${res.data.fullyShipped ? " — commande expédiée" : ""}.`,
    shipmentId: res.data.shipmentId,
    deliveryNoteNumber: res.data.deliveryNoteNumber,
  };
}

/**
 * Toggle the operator pick/pack stamp on one order line (preparation panel).
 * Advisory only — it records preparation progress for the operator and does not
 * gate the "shipped" transition. The line must belong to `orderId` (a foreign
 * line id matches nothing → `not_found`), so the panel can roll back its
 * optimistic tick and say so.
 */
export async function toggleOrderLinePickedAction(
  orderItemId: string,
  orderId: string,
  picked: boolean,
): Promise<ActionState> {
  await requirePermission("orders", "manage");
  if (!isUuid(orderItemId) || !isUuid(orderId) || typeof picked !== "boolean") {
    return { ok: false, error: "validation", message: "Ligne de commande invalide." };
  }
  const updated = await orderService.setItemPicked(orderId, orderItemId, picked);
  if (!updated) {
    return { ok: false, error: "not_found", message: "Ligne introuvable sur cette commande." };
  }
  revalidatePath(`/admin/orders/${orderId}`);
  return { ok: true };
}

/** At most this many orders per bulk status call (the list loads 50 per page). */
const BULK_STATUS_MAX = 100;
/** Orders transitioned at once — each is its own transaction + post-commit
 *  subscriber work, so an unbounded fan-out would storm the node-postgres pool
 *  (same bound as bulkDeleteMediaAction). */
const BULK_STATUS_CONCURRENCY = 8;
/** Failed orders named in the returned message (the rest are counted). */
const BULK_STATUS_FAILURES_LISTED = 5;

const bulkStatusSchema = z.object({
  orderIds: z.array(z.string().uuid()).min(1).max(BULK_STATUS_MAX),
  // 'cancelled' is deliberately NOT accepted: cancelling is destructive
  // (restock + loyalty/promo reversal + the pending-online capture check) and
  // stays a per-order action behind a confirm — enforced here, not only by the
  // list UI hiding it.
  toStatus: z.enum(["preparing", "shipped", "delivered"]),
});

/**
 * Bulk status transition — runs `transitionStatus` per id in bounded batches of
 * {@link BULK_STATUS_CONCURRENCY}. Each order is an independent transaction (own
 * status-history row, own event, own pre-check) so there is no shared state for
 * concurrent calls to race on. We don't fast-fail on a single bad transition
 * (e.g. one order is delivered and can't go back to preparing) so the admin still
 * gets partial progress — and the message names the orders that failed + why.
 */
export async function bulkUpdateOrderStatusAction(input: {
  orderIds: string[];
  toStatus: "preparing" | "shipped" | "delivered";
}): Promise<ActionState & { successCount?: number; failCount?: number }> {
  const session = await requirePermission("orders", "manage");
  const parsed = bulkStatusSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: "validation",
      message: `Sélection invalide : 1 à ${BULK_STATUS_MAX} commandes, statut préparation / expédiée / livrée.`,
    };
  }
  const orderIds = Array.from(new Set(parsed.data.orderIds));
  const { toStatus } = parsed.data;

  const results: Array<{ ok: true } | { ok: false; message: string }> = [];
  for (let i = 0; i < orderIds.length; i += BULK_STATUS_CONCURRENCY) {
    const batch = orderIds.slice(i, i + BULK_STATUS_CONCURRENCY);
    results.push(
      ...(await Promise.all(
        batch.map((orderId) =>
          workflows.order
            .transitionStatus({ orderId, toStatus }, { actorUserId: session.user.id })
            .catch(() => ({ ok: false as const, message: "Erreur interne." })),
        ),
      )),
    );
  }
  const successCount = results.filter((r) => r.ok).length;
  const failCount = results.length - successCount;
  revalidatePath("/admin/orders");

  // Name the failed orders (number + reason) — results are index-aligned with
  // `orderIds` (batches + Promise.all preserve order).
  let failureDetail = "";
  if (failCount > 0) {
    const failed = orderIds
      .map((orderId, i) => ({ orderId, res: results[i] }))
      .filter((f): f is { orderId: string; res: { ok: false; message: string } } => !f.res.ok);
    const listed = failed.slice(0, BULK_STATUS_FAILURES_LISTED);
    const numbers = new Map(
      (await findOrdersByIds(listed.map((f) => f.orderId)).catch(() => [])).map(
        (o) => [o.id, o.order_number] as const,
      ),
    );
    failureDetail =
      " — " +
      listed.map((f) => `${numbers.get(f.orderId) ?? "Commande"} : ${f.res.message}`).join(" ; ") +
      (failed.length > listed.length ? ` ; +${failed.length - listed.length} autre(s)` : "");
  }

  if (successCount === 0 && failCount > 0) {
    return {
      ok: false,
      error: "all_failed",
      message: `Aucune commande mise à jour (${failCount} échec${failCount > 1 ? "s" : ""})${failureDetail}`,
      failCount,
      successCount,
    };
  }
  return {
    ok: true,
    message:
      failCount > 0
        ? `${successCount} mise(s) à jour, ${failCount} échec(s)${failureDetail}`
        : `${successCount} commande(s) mise(s) à jour.`,
    successCount,
    failCount,
  };
}

/**
 * Flag / unflag a single order as spam (triage). Non-destructive — it only sets
 * the flag (the order drops out of the default list + the « À traiter » queue),
 * leaving cancellation as a separate deliberate step.
 */
export async function setOrderSpamAction(orderId: string, spam: boolean): Promise<ActionState> {
  const session = await requirePermission("orders", "manage");
  const result = await workflows.order.setSpam({ orderId, spam }, { actorUserId: session.user.id });
  if (!result.ok) return { ok: false, error: result.error, message: result.message };
  revalidatePath("/admin/orders");
  revalidatePath(`/admin/orders/${orderId}`);
  return { ok: true, message: spam ? "Commande marquée comme spam." : "Commande retirée du spam." };
}

/**
 * Bulk spam-flag / unflag from the Commandes list toolbar — the triage workhorse
 * (select the junk, mark it spam, it leaves the default view). Same
 * concurrency-batched, index-aligned error reporting as the bulk status action.
 */
export async function bulkSetOrderSpamAction(input: {
  orderIds: string[];
  spam: boolean;
}): Promise<ActionState & { successCount?: number; failCount?: number }> {
  const session = await requirePermission("orders", "manage");
  const parsed = z
    .object({ orderIds: z.array(z.string().uuid()).min(1).max(BULK_STATUS_MAX), spam: z.boolean() })
    .safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "validation", message: `Sélection invalide : 1 à ${BULK_STATUS_MAX} commandes.` };
  }
  const orderIds = Array.from(new Set(parsed.data.orderIds));
  const { spam } = parsed.data;

  const results: Array<{ ok: true } | { ok: false; message: string }> = [];
  for (let i = 0; i < orderIds.length; i += BULK_STATUS_CONCURRENCY) {
    const batch = orderIds.slice(i, i + BULK_STATUS_CONCURRENCY);
    results.push(
      ...(await Promise.all(
        batch.map((orderId) =>
          workflows.order
            .setSpam({ orderId, spam }, { actorUserId: session.user.id })
            .catch(() => ({ ok: false as const, message: "Erreur interne." })),
        ),
      )),
    );
  }
  const successCount = results.filter((r) => r.ok).length;
  const failCount = results.length - successCount;
  revalidatePath("/admin/orders");
  const verb = spam ? "marquée(s) comme spam" : "retirée(s) du spam";
  if (successCount === 0 && failCount > 0) {
    return { ok: false, error: "all_failed", message: `Aucune commande ${verb} (${failCount} échec(s)).`, failCount, successCount };
  }
  return {
    ok: true,
    message: failCount > 0 ? `${successCount} ${verb}, ${failCount} échec(s).` : `${successCount} commande(s) ${verb}.`,
    successCount,
    failCount,
  };
}

/**
 * Issue a partial refund against an order. Appends a row to
 * `order_refunds`; the storefront / admin pages read the running total
 * and display "Remboursé X TND sur Y TND". Does NOT auto-transition the
 * order to "refunded" — the admin chooses that separately.
 */
export async function refundOrderAction(input: {
  orderId: string;
  amountCents: number;
  reason?: string;
}): Promise<ActionState & { totalRefundedCents?: number }> {
  const session = await requirePermission("orders", "manage");
  const result = await workflows.order.refund(
    {
      orderId: input.orderId,
      amountCents: input.amountCents,
      reason: input.reason,
    },
    { actorUserId: session.user.id },
  );
  if (!result.ok) return { ok: false, error: result.error, message: result.message };
  revalidatePath(`/admin/orders/${input.orderId}`);
  return {
    ok: true,
    message: "Remboursement enregistré.",
    totalRefundedCents: result.data.totalRefundedCents,
  };
}

/**
 * Convert a stuck pending online-gateway order to cash-on-delivery. The workflow
 * re-verifies the gateway (fail-closed) and refuses if the payment was captured or
 * a session is still live — so a paid order can't be silently downgraded to COD.
 */
export async function switchOrderToCodAction(orderId: string): Promise<ActionState> {
  const session = await requirePermission("orders", "manage");
  const result = await workflows.order.switchToCod({ orderId }, { actorUserId: session.user.id });
  if (!result.ok) return { ok: false, error: result.error, message: result.message };
  revalidatePath("/admin/orders");
  revalidatePath(`/admin/orders/${orderId}`);
  return { ok: true, message: "Commande basculée en paiement à la livraison." };
}

/**
 * Convert a précommande order at RELEASE — consume its stock reservations,
 * decrement real stock for each, and mark the order converted. Mirrors the
 * placement flow's deferred decrement. See `convertPreorderOrderWorkflow`.
 */
export async function convertPreorderOrderAction(orderId: string): Promise<ActionState> {
  const session = await requirePermission("orders", "manage");
  const result = await workflows.order.convertPreorder({ orderId }, { actorUserId: session.user.id });
  if (!result.ok) return { ok: false, error: result.error, message: result.message };
  if (!result.data.converted) {
    return { ok: false, error: "conflict", message: "Cette commande n'est pas une précommande à convertir." };
  }
  revalidatePath(`/admin/orders/${orderId}`);
  revalidatePath("/admin/orders");
  revalidatePath("/admin/catalog/preorders");
  return { ok: true, message: "Précommande convertie : stock décrémenté." };
}

/**
 * Admin-side patch for `payment_method` + `payment_reference`. Used when
 * payment lands outside the gateway (wire transfer, in-person cash) and
 * the order needs the receipt fields backfilled.
 */
export async function setOrderPaymentReferenceAction(input: {
  orderId: string;
  paymentMethod?: string | null;
  paymentReference: string;
}): Promise<ActionState> {
  const session = await requirePermission("orders", "manage");
  const result = await workflows.order.setPaymentReference(
    {
      orderId: input.orderId,
      paymentMethod: input.paymentMethod ?? null,
      paymentReference: input.paymentReference,
    },
    { actorUserId: session.user.id },
  );
  if (!result.ok) return { ok: false, error: result.error, message: result.message };
  revalidatePath("/admin/orders");
  revalidatePath(`/admin/orders/${input.orderId}`);
  return { ok: true, message: "Référence de paiement enregistrée." };
}

/**
 * Per-order invoice TVA control (manual override / recompute) — the admin
 * "TVA facture" form. The displayed tax is `tax_manual_cents ?? tax_cents`.
 *
 *   • "manual" → override the printed TVA with `amountDinars`.
 *   • "global" → drop the override and restore the sale TVA (per-line snapshots
 *     + shipping term).
 *
 * Thin wrapper over `workflows.order.setInvoiceTax`, which locks the order,
 * refuses once the invoice / credit note is numbered (correct via an avoir),
 * only moves the total when the TVA is charged on top AND the amount is still to
 * collect, and emits `order.edited` so the change is audited + webhooked.
 */
export async function setOrderInvoiceTaxAction(
  orderId: string,
  input:
    | { mode: "manual"; amountDinars: number }
    | { mode: "global" },
): Promise<ActionState> {
  // Per-order TVA override accepts orders:manage OR the dedicated orders:update
  // capability (the RBAC engine has no action hierarchy). This keeps it reachable
  // by a full order-manager AND by the lighter TVA-only role the invoice form is
  // gated for (canUpdate = manage||update, admin/orders/[id]/page.tsx) — so the
  // page control and this guard agree. Uses the requirePermissionAny
  // dual-capability pattern. (A-Z re-audit Phase 3 + self-review.)
  const session = await requirePermissionAny([
    { module: "orders", action: "manage" },
    { module: "orders", action: "update" },
  ]);

  let request: { orderId: string; mode: "manual"; amountCents: number } | { orderId: string; mode: "global" };
  if (input.mode === "manual") {
    const amount = Number(input.amountDinars);
    if (!Number.isFinite(amount) || amount < 0) {
      return { ok: false, error: "validation", message: "Montant de TVA invalide." };
    }
    request = { orderId, mode: "manual", amountCents: dinarsToMinor(amount) };
  } else {
    request = { orderId, mode: "global" };
  }

  const result = await workflows.order.setInvoiceTax(request, { actorUserId: session.user.id });
  if (!result.ok) return { ok: false, error: result.error, message: result.message };

  revalidatePath(`/admin/orders/${orderId}`);
  revalidatePath(`/admin/orders/${orderId}/invoice`);
  if (result.data.totalChanged) revalidatePath("/admin/orders");
  const base =
    input.mode === "manual"
      ? "TVA facture mise à jour."
      : "TVA recalculée d'après les lignes de la commande.";
  return {
    ok: true,
    message: !result.data.changed
      ? "Aucun changement : la TVA facture est déjà à jour."
      : result.data.totalChanged
        ? `${base} Total de la commande ajusté (TVA ajoutée au prix HT).`
        : base,
  };
}

/**
 * Link a guest order (`user_id IS NULL`) to an existing customer account so it
 * joins that customer's history. The admin order page resolves candidate
 * accounts by the order's contact email and passes the chosen `userId` here
 * (called directly by the `GuestOrderLink` client component, which shows the
 * returned message); the workflow re-checks the order is still a guest order
 * before setting `user_id` (a stale tab can't reassign an already-linked order →
 * `already_linked`).
 *
 * Guarded by `requirePermission("orders", "manage")` — only order managers link
 * orders to accounts.
 */
export async function linkGuestOrderAction(
  orderId: string,
  userId: string,
): Promise<ActionState> {
  const session = await requirePermission("orders", "manage");
  const result = await workflows.order.linkGuestOrder(
    { orderId, userId },
    { actorUserId: session.user.id },
  );
  if (!result.ok) return { ok: false, error: result.error, message: result.message };
  revalidatePath("/admin/orders");
  revalidatePath(`/admin/orders/${orderId}`);
  return { ok: true, message: "Commande rattachée au compte client." };
}

/**
 * Shape of the checkout / quick-buy submission. Both flows hit the same
 * action layer so server-side validation + audit + downstream events stay
 * in one place.
 *
 * `quickProductId` distinguishes the quick-buy path: the workflow
 * synthesises a one-item ephemeral cart for that product, places the order,
 * then discards the cart. The user's actual cart (if any) is untouched.
 */
export type PlaceOrderInput = {
  contactEmail: string;
  contactPhone?: string;
  fullName: string;
  streetLine1: string;
  streetLine2?: string;
  city: string;
  region?: string;
  postalCode?: string;
  country?: string;
  shipPhone?: string;
  /** Saved address the shopper picked at checkout — updated in place (not duplicated). */
  selectedAddressId?: string;
  paymentMethod?: "cod" | "flouci" | "clictopay" | "card_stripe";
  notes?: string;
  /**
   * Chosen delivery method + the selected agent / pickup location. The order
   * workflow re-validates and prices these authoritatively via `resolveDelivery`;
   * an absent method defaults to `home_delivery` (the legacy flat-rate path).
   */
  deliveryMethod?: "home_delivery" | "drive_by_pickup" | "in_store";
  deliveryAgentId?: string;
  pickupLocationId?: string;
  /** Quick-buy mode. When set, ignores the active cart and uses only this product. */
  quickProductId?: string;
  quickVariantId?: string | null;
  quickQuantity?: number;
  /** Chosen Tokyo Care plan for the quick-buy line (re-validated server-side). */
  quickCarePlanId?: string | null;
  /**
   * Express only: a UUID the buy form generates once per mount and re-sends on
   * every submit of that form. The workflow derives its ephemeral cart token from
   * it, so a replayed / double-fired submit hits the cart claim guard instead of
   * placing a second order. Optional (an older client omits it).
   */
  idempotencyKey?: string;
};

/**
 * Place an order from the active cart (anonymous or signed-in).
 *
 * Returns `{ ok: true, orderId, orderNumber }` so the client can redirect
 * to `/order/<orderId>` without re-reading the cookie.
 */
export async function placeOrderFromCartAction(
  input: PlaceOrderInput,
): Promise<PlaceOrderActionState> {
  const session = await getSession();
  // READ-ONLY cart lookup first: a guest (cookieless / scripted) caller with no
  // cart is refused here without INSERTing a `carts` row. A signed-in shopper's
  // cart is resolved (guest-cart merge + get-or-create, one row per account)
  // after the throttle below.
  const guestCart = session?.user ? null : await readCart();
  if (!session?.user && !guestCart) {
    return { ok: false, error: "empty_cart", message: "Votre panier est vide." };
  }

  // Server-side defense-in-depth. The order workflow schema now accepts an empty
  // email / city (the express + pickup flows legitimately omit them), so re-check
  // here what the full checkout form actually requires: the email field is gated
  // on the same checkout config, and a home-delivery order always needs a city.
  // A tampered/scripted submit can't slip past the client `required` attributes.
  const quickConfig = await getQuickBuyConfig();
  const checkoutFields = quickConfig.fields;
  // A blank email falls back to the signed-in account's address, so an account
  // holder always gets the receipt / confirmation / status emails even though
  // the default checkout config shows no email field. When the form renders no
  // email input (checkout-form gates it on this same flag) a submitted address
  // is ignored — only a scripted client could send one, to aim receipts at an
  // arbitrary inbox. If the cart form's email field is ever made always-visible,
  // flip this flag with it.
  const contactEmail = resolveOrderContactEmail({
    submitted: input.contactEmail,
    sessionEmail: session?.user?.email,
    acceptSubmitted: checkoutFields.email.enabled,
  });
  const trimmedCity = (input.city ?? "").trim();
  if (checkoutFields.email.enabled && checkoutFields.email.required && !contactEmail) {
    return { ok: false, error: "validation", message: "Email requis." };
  }
  // Phone is required by default (checkout.quick.phone_required) — a delivery
  // order needs a reachable number. The full form already marks it required via
  // the same config; enforce it here too so a scripted/tampered submit can't
  // create a phone-less order (parity with the express path).
  const trimmedPhone = (input.contactPhone ?? input.shipPhone ?? "").trim();
  if (checkoutFields.phone.enabled && checkoutFields.phone.required && !trimmedPhone) {
    return { ok: false, error: "validation", message: "Téléphone requis." };
  }
  if ((input.deliveryMethod ?? "home_delivery") === "home_delivery" && !trimmedCity) {
    return { ok: false, error: "validation", message: "Ville requise pour la livraison à domicile." };
  }
  // Governorate (region) drives zone pricing + courier routing — a home-delivery
  // order without one can't be priced/routed. Mirrors the client guard so a
  // tampered/scripted submit can't bypass the form's required field.
  const trimmedRegion = (input.region ?? "").trim();
  if (
    (input.deliveryMethod ?? "home_delivery") === "home_delivery" &&
    !trimmedRegion
  ) {
    return {
      ok: false,
      error: "validation",
      message: "Gouvernorat requis pour la livraison à domicile.",
    };
  }
  // A pickup order must name its point: the storefront only offers a pickup
  // method together with its locations, so a location-less pickup is a tampered
  // submit. (Operator counter sales legitimately omit it and go through the
  // manual-order path, not this action.)
  if ((input.deliveryMethod ?? "home_delivery") !== "home_delivery" && !input.pickupLocationId) {
    return { ok: false, error: "validation", message: "Choisissez un point de retrait." };
  }

  // AUTHORITATIVE payment-method enforcement — the full-cart checkout form only
  // hides UI radios, so re-resolve the submitted method against the admin's
  // gateway/COD toggles here (the same gate the quick-buy path uses). Blocks
  // paying through a disabled gateway; an empty/unknown method is treated as a
  // COD intent (COD when enabled, else the first enabled gateway).
  const resolvedPayment = resolvePaymentMethod(input.paymentMethod, quickConfig.payment);
  if (!resolvedPayment.ok) {
    return { ok: false, error: "validation", message: resolvedPayment.message };
  }
  const paymentMethod = resolvedPayment.method;

  // Abuse throttle (per IP, + a peek at the per-phone / per-email placed-order
  // counts) BEFORE the cart resolve and the workflow — an unauthenticated script
  // could otherwise flood the Commandes queue, hold tracked stock and mail
  // receipts to arbitrary inboxes. The only earlier writes are the IP bucket
  // itself (and nothing at all for a cart-less guest, refused above).
  const allowed = await checkOrderPlacementRateLimit({
    ip: getClientIp(await headers()),
    phone: trimmedPhone,
    email: contactEmail,
  });
  if (!allowed) {
    return { ok: false, error: "rate_limited", message: ORDER_RATE_LIMITED_MESSAGE };
  }
  const cart = guestCart ?? (await resolveCart());

  // Pick the coupon candidate (`gz.coupon`, else the `gz.promo` fallback) on the
  // SAME basis /panier and /checkout display it: the LIVE re-priced subtotal +
  // per-line context (not the add-time `cart_items` prices, which go stale when
  // an auto-promo ends / starts or a base price changes — a min-cart band or a
  // scoped code could then forward a different promotion than the one shown).
  // place-order re-evaluates the forwarded id authoritatively and recomputes the
  // discount; the shipping fee is resolved there too (`resolveDelivery`).
  const live = await priceCartLinesLive(await cartService.listItems(cart.id));
  const appliedPromo = await resolveAppliedCartPromotion(
    live.subtotalCents,
    session?.user?.id ?? null,
    live.discountableSubtotalCents,
    couponLinesOf(live),
  );

  const result = await workflows.order.place(
    {
      cartId: cart.id,
      contactEmail,
      contactPhone: input.contactPhone,
      shipping: {
        fullName: input.fullName,
        streetLine1: input.streetLine1,
        streetLine2: input.streetLine2,
        city: input.city,
        region: input.region,
        postalCode: input.postalCode,
        country: input.country ?? "TN",
        phone: input.shipPhone ?? input.contactPhone,
        // Edit-in-place: when the shopper picked a saved address, the workflow
        // updates that row instead of inserting a duplicate. Undefined for a
        // new ("+ Nouvelle adresse") or pickup order.
        selectedAddressId: input.selectedAddressId,
      },
      // Delivery selection — re-validated + priced authoritatively in the
      // workflow via `resolveDelivery` (home_delivery default resolves to the
      // legacy flat-rate/free-shipping preview; an agent/pickup choice adjusts
      // the final charge server-side; a disabled/stale method or pickup point
      // is refused with `delivery_unavailable`, never re-routed).
      deliveryMethod: input.deliveryMethod ?? "home_delivery",
      deliveryAgentId: input.deliveryAgentId,
      pickupLocationId: input.pickupLocationId,
      promotionId: appliedPromo?.promotionId,
      paymentMethod,
      notes: input.notes,
    },
    { actorUserId: session?.user.id ?? null },
  );

  if (!result.ok) {
    return { ok: false, error: result.error, message: result.message };
  }
  // Only a PLACED order counts against the contact's phone / email buckets.
  await recordOrderPlaced({ phone: trimmedPhone, email: contactEmail });

  // Drop the cart cookie so the next request starts fresh (the workflow
  // already emptied the cart row server-side, but the cookie token still
  // pointed at it). Also clear the coupon cookie so the next visit doesn't
  // try to re-apply a one-shot promotion.
  const jar = await cookies();
  jar.delete("gz.cart_token");
  jar.delete("gz.coupon");

  revalidatePath("/panier");

  // Online payment: create the gateway session now and hand the client a
  // redirect URL. If init fails the order still exists (pending) — the customer
  // lands on the order page and resumes payment via `resumeOrderPaymentAction`
  // (the "Reprendre le paiement" control). A zero-total order is settled here
  // instead (no gateway) and the client goes straight to the order page.
  let redirectUrl: string | undefined;
  if (isOnlineMethod(paymentMethod)) {
    const pay = await startOnlinePayment(result.data.orderId, session?.user?.id ?? null);
    if (pay.ok) redirectUrl = pay.redirectUrl;
  }

  return {
    ok: true,
    orderId: result.data.orderId,
    orderNumber: result.data.orderNumber,
    redirectUrl,
  };
}

/**
 * Quick-buy path: skip the cart entirely. Used by the "Acheter maintenant"
 * morph on the product page — the user only wants the single SKU and
 * doesn't care about the rest of their cart.
 *
 * The actual ephemeral-cart + placement orchestration lives in
 * `workflows.order.placeQuick` so validation + audit + downstream events
 * stay in one place. The user's real cart isn't touched.
 */
export async function placeQuickOrderAction(
  input: PlaceOrderInput,
): Promise<PlaceOrderActionState> {
  if (!input.quickProductId) {
    return { ok: false, error: "validation", message: "Produit manquant." };
  }
  const quantity = Math.max(1, Math.min(99, input.quickQuantity ?? 1));
  if (input.idempotencyKey !== undefined && !isUuid(input.idempotencyKey)) {
    return {
      ok: false,
      error: "validation",
      message: "Requête invalide. Rechargez la page puis réessayez.",
    };
  }

  // Phone is a hard requirement on every order (see quick-buy-config). The
  // express form marks it required, but enforce server-side too so a scripted /
  // tampered submit can't create a phone-less COD order (parity with the
  // full-cart path).
  const phone = (input.contactPhone ?? input.shipPhone ?? "").trim();
  if (!phone) {
    return { ok: false, error: "validation", message: "Téléphone requis." };
  }

  const session = await getSession();
  const quickConfig = await getQuickBuyConfig();

  // Master express switch, enforced server-side: the admin toggle only hid the
  // button, so a scripted submit could keep placing express orders after the
  // operator switched express off (e.g. during an abuse wave).
  if (!quickConfig.enabled) {
    return {
      ok: false,
      error: "not_available",
      message: "L'achat express est désactivé. Ajoutez le produit au panier pour commander.",
    };
  }
  // A pickup order must name its point (the express picker always pre-selects
  // one); a location-less pickup is a tampered submit.
  if ((input.deliveryMethod ?? "home_delivery") !== "home_delivery" && !input.pickupLocationId) {
    return { ok: false, error: "validation", message: "Choisissez un point de retrait." };
  }

  // When the express form shows no email field (the default), a submitted
  // address is ignored — only a scripted client could send one, to aim receipts
  // at an arbitrary inbox. A blank email falls back to the signed-in account's.
  const contactEmail = resolveOrderContactEmail({
    submitted: input.contactEmail,
    sessionEmail: session?.user?.email,
    acceptSubmitted: quickConfig.fields.email.enabled,
  });

  // Quick-buy doesn't have a real cart row yet — the workflow stages an
  // ephemeral one. To still honour an applied coupon / URL promo we pass BOTH
  // cookie candidates down in the cart resolver's order (`gz.coupon`, then the
  // `gz.promo` fallback); the workflow forwards the first one eligible for its
  // computed line, so an ineligible code no longer hides an eligible URL promo.
  // A stale cookie just gets skipped, never charged at.
  const promotionCandidates = await readCartPromotionCandidates();

  // AUTHORITATIVE payment-method enforcement — the same gate the full-cart path
  // uses (express and cart offer the identical method set). The express form
  // only hides UI radios; here we honour the admin's gateway/COD enable toggles
  // and reject a disabled gateway; an empty/unknown method is a COD intent.
  const resolvedPayment = resolvePaymentMethod(input.paymentMethod, quickConfig.payment);
  if (!resolvedPayment.ok) {
    return { ok: false, error: "validation", message: resolvedPayment.message };
  }
  const paymentMethod = resolvedPayment.method;

  // Abuse throttle BEFORE the workflow stages its ephemeral cart (per IP, + a
  // peek at the per-phone / per-email placed-order counts) — see
  // placeOrderFromCartAction.
  const allowed = await checkOrderPlacementRateLimit({
    ip: getClientIp(await headers()),
    phone,
    email: contactEmail,
  });
  if (!allowed) {
    return { ok: false, error: "rate_limited", message: ORDER_RATE_LIMITED_MESSAGE };
  }

  const result = await workflows.order.placeQuick(
    {
      productId: input.quickProductId,
      variantId: input.quickVariantId ?? null,
      carePlanId: input.quickCarePlanId ?? null,
      quantity,
      contactEmail,
      contactPhone: input.contactPhone,
      shipping: {
        fullName: input.fullName,
        streetLine1: input.streetLine1,
        streetLine2: input.streetLine2,
        city: input.city,
        region: input.region,
        postalCode: input.postalCode,
        country: input.country ?? "TN",
        phone: input.shipPhone ?? input.contactPhone,
      },
      deliveryMethod: input.deliveryMethod ?? "home_delivery",
      deliveryAgentId: input.deliveryAgentId,
      pickupLocationId: input.pickupLocationId,
      paymentMethod,
      notes: input.notes,
      promotionCandidates,
      idempotencyKey: input.idempotencyKey,
    },
    { actorUserId: session?.user.id ?? null },
  );

  if (!result.ok) {
    return { ok: false, error: result.error, message: result.message };
  }
  // Only a PLACED order counts against the contact's phone / email buckets.
  await recordOrderPlaced({ phone, email: contactEmail });

  // Drop the code cookie ONLY when this express order actually redeemed that
  // code — it was applied to the customer's (untouched) real cart, so an
  // unrelated express purchase must not silently remove it.
  const couponCandidate = promotionCandidates.find((c) => c.source === "code");
  if (couponCandidate && result.data.redeemedPromotionId === couponCandidate.id) {
    (await cookies()).delete("gz.coupon");
  }

  // Online payment: create the gateway session and return its redirect URL.
  // Use the RESOLVED method (a disabled-gateway request was already rejected
  // above) so an online order redirects and a COD order confirms directly. A
  // zero-total order is settled without a gateway (see startOnlinePayment).
  let redirectUrl: string | undefined;
  if (isOnlineMethod(paymentMethod)) {
    const pay = await startOnlinePayment(result.data.orderId, session?.user?.id ?? null);
    if (pay.ok) redirectUrl = pay.redirectUrl;
  }

  return {
    ok: true,
    orderId: result.data.orderId,
    orderNumber: result.data.orderNumber,
    redirectUrl,
  };
}

/**
 * Ownership gate for the CUSTOMER-facing order actions below. Unlike the admin
 * actions (which use `requirePermission`), these are reachable by an
 * unauthenticated guest holding the order UUID. The rule mirrors the order
 * page's secrets-access model: a REGISTERED order needs its owner signed in; a
 * GUEST order (no `user_id`) trusts the UUID-holder (the same credential that
 * already unlocks the order summary / rider share / QR).
 */
async function resolveOrderActor(
  orderId: string,
): Promise<
  | { ok: true; order: NonNullable<Awaited<ReturnType<typeof findOrderById>>>; actorUserId: string | null }
  | { ok: false; error: string; message: string }
> {
  if (!isUuid(orderId)) {
    return { ok: false, error: "not_found", message: "Commande introuvable." };
  }
  const order = await findOrderById(orderId).catch(() => null);
  if (!order) return { ok: false, error: "not_found", message: "Commande introuvable." };
  const session = await getSession();
  const userId = session?.user?.id ?? null;
  const canAct = order.user_id ? userId === order.user_id : true;
  if (!canAct) {
    return { ok: false, error: "forbidden", message: "Action non autorisée." };
  }
  return { ok: true, order, actorUserId: userId };
}

/**
 * Customer-facing "Reprendre le paiement" — re-initiate the gateway session for
 * a still-pending ONLINE order and hand back a fresh redirect URL. Ownership +
 * the pending/online guards are enforced here and again in `initiatePayment`
 * (which overwrites the stored reference so a new gateway session is created).
 * Rate-limited per order so a stuck customer can't hammer the gateway init. A
 * zero-total order is settled instead and redirected to its confirmation.
 */
export async function resumeOrderPaymentAction(
  orderId: string,
): Promise<PlaceOrderActionState> {
  const gate = await resolveOrderActor(orderId);
  if (!gate.ok) return { ok: false, error: gate.error, message: gate.message };
  if (gate.order.status !== "pending") {
    return {
      ok: false,
      error: "not_pending",
      message: "Cette commande n'est plus en attente de paiement.",
    };
  }
  if (!isOnlineMethod(gate.order.payment_method)) {
    return {
      ok: false,
      error: "not_online",
      message: "Cette commande n'utilise pas un paiement en ligne.",
    };
  }
  const rl = await checkRateLimit({
    bucket: `resume-payment:${orderId}`,
    max: 5,
    windowSeconds: 60,
  }).catch(() => ({ ok: true }) as { ok: boolean });
  if (!rl.ok) {
    return {
      ok: false,
      error: "rate_limited",
      message: "Trop de tentatives. Réessayez dans une minute.",
    };
  }
  const pay = await startOnlinePayment(orderId, gate.actorUserId);
  if (!pay.ok) return { ok: false, error: pay.error, message: pay.message };
  if (pay.redirectUrl) return { ok: true, orderId, redirectUrl: pay.redirectUrl };
  // A zero-total order was just settled (nothing to pay) — reload it as a fresh
  // confirmation instead of a gateway redirect.
  revalidatePath(`/order/${orderId}`);
  return { ok: true, orderId, redirectUrl: `/order/${orderId}?fresh=1` };
}

/**
 * Customer-facing "Annuler la commande" — cancel a still-pending ONLINE order
 * (payment not completed). Goes through the shared transition workflow
 * (row-locked, restocks + reverses loyalty/promos, writes status history).
 * Restricted to online methods, like its only UI (the pending-online controls):
 * a guest COD order is cancellable by anyone holding its UUID otherwise — before
 * or even after staff confirmed it — with a misleading « paiement non finalisé »
 * note. A non-pending order is rejected.
 */
export async function cancelMyPendingOrderAction(orderId: string): Promise<ActionState> {
  const gate = await resolveOrderActor(orderId);
  if (!gate.ok) return { ok: false, error: gate.error, message: gate.message };
  if (gate.order.status !== "pending") {
    return {
      ok: false,
      error: "not_pending",
      message: "Seule une commande en attente peut être annulée.",
    };
  }
  if (!isOnlineMethod(gate.order.payment_method)) {
    return {
      ok: false,
      error: "not_online",
      message: "Cette commande ne peut pas être annulée en ligne.",
    };
  }
  // Fail-closed: never cancel a paid-but-unsettled online order out from under a
  // customer (mirrors the reconcile cron's definitive-terminal-only rule).
  const blocked = await guardPendingOnlineCancel(orderId, gate.actorUserId);
  if (blocked) return blocked;
  const result = await workflows.order.transitionStatus(
    {
      orderId,
      toStatus: "cancelled",
      notes: "Annulée par le client (paiement non finalisé).",
    },
    { actorUserId: gate.actorUserId },
  );
  if (!result.ok) return { ok: false, error: result.error, message: result.message };
  revalidatePath(`/order/${orderId}`);
  revalidatePath("/account");
  return { ok: true, message: "Commande annulée." };
}

// ─────────────────────────────────────────────────────────── public order tracking
import type { OrderStatus } from "@/lib/order/status";

/** The status payload returned to a guest who proves ownership of an order. */
export type TrackedOrder = {
  number: string;
  status: OrderStatus;
  placedAtIso: string;
  totalCents: number;
  deliveryMethod: string;
};

/** Last 8 digits of a phone — the significant part of a Tunisian number whatever
 *  the prefix/formatting the customer typed at checkout. */
function phoneTail(s: string | null | undefined): string {
  return (s ?? "").replace(/\D/g, "").slice(-8);
}

/**
 * Public « Suivi de commande » lookup: find one order by its number, authorised
 * by the contact/shipping phone (last 8 digits) — no account required. Never
 * leaks an order's existence/status to someone who can't supply the matching
 * phone (generic refusal), and IP-throttled so the number+phone space can't be
 * ground. `(prev, formData)` shape for useActionState.
 */
export async function trackOrderAction(
  _prev: (ActionState & { order?: TrackedOrder }) | null,
  formData: FormData,
): Promise<ActionState & { order?: TrackedOrder }> {
  const number = String(formData.get("orderNumber") ?? "").trim();
  const phone = String(formData.get("phone") ?? "").trim();
  if (!number || !phone) {
    return { ok: false, error: "validation", message: "Numéro de commande et téléphone requis." };
  }
  const ip = getClientIp(await headers());
  const rl = await checkRateLimit({ bucket: `track-order:${ip}`, max: 10, windowSeconds: 60 }).catch(
    () => ({ ok: true }) as { ok: boolean },
  );
  if (!rl.ok) {
    return { ok: false, error: "rate_limited", message: "Trop de tentatives. Réessayez dans un instant." };
  }
  const order = await findOrderByNumber(number).catch(() => null);
  const given = phoneTail(phone);
  const authorised =
    !!order &&
    given.length >= 6 &&
    (phoneTail(order.contact_phone) === given || phoneTail(order.ship_phone) === given);
  if (!order || !authorised) {
    return {
      ok: false,
      error: "not_found",
      message:
        "Aucune commande ne correspond à ces informations. Vérifiez le numéro et le téléphone utilisés lors de la commande.",
    };
  }
  return {
    ok: true,
    order: {
      number: order.order_number,
      status: order.status as OrderStatus,
      placedAtIso: order.created_at.toISOString(),
      totalCents: order.total_cents,
      deliveryMethod: order.delivery_method,
    },
  };
}
