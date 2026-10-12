import "server-only";

import { z } from "zod";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";

import { db, type DbOrTx } from "@/lib/db/client";
import { bus } from "@/events/bus";
import {
  order_returns,
  order_return_items,
  RETURN_REASON_CODES,
  SHIPMENT_RETURN_REASON_CODES,
  ORDER_RETURN_KINDS,
  type OrderReturnItemRow,
} from "@/modules/order/returns.schema";
import { products, product_variants } from "@/modules/catalog/product/schema";
import { orderService } from "@/modules/order/service";
import { returnService } from "@/modules/order/returns.service";
import { getSharedStockDefault, isSharedStock } from "@/lib/inventory/variant-stock";
import { stockMovementService } from "@/modules/stock-movement";
import { goodsLeftWarehouse, returnBlockedByRefundRestock, sumRefundCents } from "@/lib/order/fulfilment-state";
import { reconcileOrderPromos } from "./reconcile-order-promos";
import { emitRestockEvents } from "./restock";
import { fail, ok, workflow } from "../shared";

/** Order statuses for which a physical return makes sense (goods reached the
 *  customer). Pending/paid/preparing never shipped; cancelled already restocked.
 *  A cheap pre-filter only — `refunded` is re-checked against the fulfilment
 *  HISTORY inside the tx (goodsLeftWarehouse). Exported so the order page hides
 *  the create-return form on the statuses this workflow refuses. */
export const RETURNABLE_STATUSES: ReadonlySet<string> = new Set(["shipped", "delivered", "refunded"]);

export const createReturnSchema = z.object({
  orderId: z.string().uuid(),
  /** `after_sale` (classic SAV, default) | `shipment` (« Retour d'expédition »
   *  — a shipped parcel that bounced back). See ORDER_RETURN_KINDS. */
  kind: z.enum(ORDER_RETURN_KINDS).default("after_sale"),
  // Loosened from z.enum(RETURN_REASON_CODES) to a plain string because the two
  // kinds draw from DISJOINT taxonomies (RETURN_REASON_CODES vs
  // SHIPMENT_RETURN_REASON_CODES) — membership is validated per-kind below.
  reasonCode: z.string().trim().max(60).optional(),
  reason: z.string().trim().max(500).optional(),
  comment: z.string().trim().max(2000).optional(),
  /** « Retour d'expédition » only — external carrier + tracking + failed-attempt
   *  count snapshot (ignored for an after_sale return). */
  carrierName: z.string().trim().max(120).optional(),
  trackingRef: z.string().trim().max(120).optional(),
  deliveryAttempts: z.number().int().min(0).max(50).optional(),
  lines: z
    .array(
      z.object({
        orderItemId: z.string().uuid(),
        quantity: z.number().int().min(1),
        restockable: z.boolean().default(true),
        conditionNote: z.string().trim().max(500).optional(),
      }),
    )
    .min(1),
});

/**
 * Raise a return against an order. Validates each line belongs to the order and
 * its quantity doesn't exceed what was sold MINUS what's already (non-rejected)
 * returned. Creates a `pending` return; restock happens on RECEIVE.
 *
 * Two kinds (same validation + restock machinery, different trigger + outcome):
 *   - `after_sale` : the customer received the goods and sends them back —
 *     allowed on shipped/delivered/refunded orders (RETURNABLE_STATUSES).
 *   - `shipment`   : a « Retour d'expédition » (RTO) — allowed ONLY on a
 *     `shipped` order (the parcel left but never reached the customer).
 *     Receiving it additionally cancels the order (see receiveReturnWorkflow).
 */
export const createReturnWorkflow = workflow<
  [z.input<typeof createReturnSchema>, { actorUserId?: string | null }],
  { returnId: string }
>("order.return.create", async (input, { actorUserId }) => {
  const parsed = createReturnSchema.safeParse(input);
  if (!parsed.success) return fail("validation", "Validation échouée");
  const d = parsed.data;

  // Reason code must belong to the kind's own taxonomy (disjoint sets) — a junk
  // or cross-kind code is rejected rather than silently stored + mis-charted.
  const allowedReasons: readonly string[] =
    d.kind === "shipment" ? SHIPMENT_RETURN_REASON_CODES : RETURN_REASON_CODES;
  if (d.reasonCode && !allowedReasons.includes(d.reasonCode)) {
    return fail("validation", "Motif de retour invalide pour ce type de retour.");
  }

  const order = await orderService.findById(d.orderId);
  if (!order) return fail("not_found", "Commande introuvable.");
  if (d.kind === "shipment") {
    // A « Retour d'expédition » is specifically a SHIPPED-but-undelivered parcel.
    // A delivered order that comes back is a classic after-sale return instead.
    if (order.status !== "shipped") {
      return fail(
        "invalid_status",
        "Un retour d'expédition ne concerne qu'une commande au statut « Expédiée ».",
      );
    }
  } else if (!RETURNABLE_STATUSES.has(order.status)) {
    // Only goods that actually reached the customer can be returned. Blocks
    // returning a cancelled order (already restocked), a pending/paid/preparing
    // one (never shipped) — which would otherwise inflate stock on receive.
    return fail("invalid_status", "Seules les commandes expédiées, livrées ou remboursées peuvent faire l'objet d'un retour.");
  }

  const result = await db.transaction(async (tx) => {
    // Serialize concurrent return creation on this order: lock the order row so
    // two operators (or a double-submit) can't both pass the remaining-qty check
    // on the same stale snapshot and over-return → over-restock on receive. The
    // items + already-returned counts are RE-READ on the tx after the lock.
    const locked = await orderService.findById(d.orderId, tx, { forUpdate: true });

    // The STATUS gate above lets `refunded` through, but an order refunded
    // straight from `paid` never shipped: its goods are still on the shelf, and
    // a later full refund (or top-up) restocks the whole quantity — a received
    // return would then be counted twice. Same history-based predicate as the
    // refund restock decision (fulfilment-state), so both always agree.
    if (!(await goodsLeftWarehouse(locked ?? order, tx))) {
      return {
        ok: false as const,
        message: "Les articles de cette commande ne sont jamais sortis de l'entrepôt : aucun retour physique n'est possible.",
      };
    }

    const items = await orderService.listItemsInTx(tx, d.orderId);
    const itemById = new Map(items.map((i) => [i.id, i]));
    const alreadyReturned = await returnService.returnedQtyByOrderItem(d.orderId, tx);

    // Only PHYSICALLY-SHIPPED units can be returned + restocked. A return
    // restocks on receive, and the cancel/refund path already restocks the
    // UNSHIPPED remainder — so returning an unshipped unit would double-restock.
    //  - Order HAS shipment records → a line's returnable ceiling is its SHIPPED
    //    qty (shipment_items), not the ordered qty (caps a partially-shipped
    //    order's returns to what actually left the warehouse).
    // KNOWN LIMITATION (mixed fulfilment): if an order was PARTIALLY BL'd (line A
    // has a shipment, line B does not) and then directly marked delivered, line B's
    // ceiling here is 0 — B is recoverable only via a FULL refund (which restocks
    // its remainder), not a per-line return. Do NOT "fix" this by falling back to
    // B's ordered qty: the refund remainder does not subtract already-returned qty,
    // so B could then be restocked by BOTH a received return AND a later full
    // refund (double-restock). Forcing complete BL coverage before delivery is the
    // correct larger fix if this becomes a real workflow.
    //  - Order has NO shipment records (e.g. marked delivered without a bon de
    //    livraison) → fall back to the ordered qty so those returns still work,
    //    EXCEPT a shipment-less order whose FULL refund already restored its
    //    stock: block it (would otherwise double-restock).
    const shippedByItem = await orderService.shippedQtyByItem(d.orderId, tx);
    const hasShipments = shippedByItem.size > 0;
    // Block a return on a shipment-less, FULLY refunded order ONLY when that
    // refund actually restocked (returnBlockedByRefundRestock — the goods never
    // left, or the ledger holds `refund` restock rows). Key on the refund LEDGER
    // (SUM(order_refunds) >= total), NOT status==='refunded': refundOrderWorkflow
    // does not set that status (a separate manual admin transition). A full
    // refund of goods that LEFT with no BL restocks nothing (refund-order.ts), so
    // those units must stay returnable — the return is their only way back to
    // sellable stock. Scoped to !hasShipments so a partially-shipped + fully-
    // refunded order (its shipped units still returnable) isn't over-blocked.
    const refundedCents = sumRefundCents(await orderService.listRefunds(d.orderId, tx));
    if (
      await returnBlockedByRefundRestock(locked ?? order, { hasShipments, refundedCents }, tx)
    ) {
      return {
        ok: false as const,
        message:
          "Cette commande a été intégralement remboursée et ce remboursement a déjà réintégré son stock : aucun retour physique n'est possible.",
      };
    }

    // « Retour d'expédition » requires a FULLY-shipped order. A partially-shipped
    // order (partial BL, then manually bumped `preparing → shipped`) has an
    // unshipped remainder that was decremented at placement but WON'T be restocked
    // by the RTO (the return caps each line to its shipped qty) nor by the RTO
    // cancel (which skips the full-restock), and `cancelled` is terminal with no
    // refund-of-remainder path left — a permanent stock under-count. Direct those
    // to « Retour après vente » (shipped part) + a refund for the remainder.
    if (d.kind === "shipment" && hasShipments) {
      const partiallyShipped = items.some((it) => (shippedByItem.get(it.id) ?? 0) < it.quantity);
      if (partiallyShipped) {
        return {
          ok: false as const,
          message:
            "Commande partiellement expédiée : gérez-la via « Retour après vente » (part expédiée) + remboursement du reliquat, pas via un retour d'expédition.",
        };
      }
    }

    // Validate each line, and collapse duplicate order_item lines in the request.
    const requestedByItem = new Map<string, number>();
    for (const line of d.lines) {
      const item = itemById.get(line.orderItemId);
      if (!item) return { ok: false as const, message: "Ligne de commande introuvable pour ce retour." };
      const priorInRequest = requestedByItem.get(line.orderItemId) ?? 0;
      const ceiling = hasShipments ? (shippedByItem.get(item.id) ?? 0) : item.quantity;
      const remaining = ceiling - (alreadyReturned.get(item.id) ?? 0) - priorInRequest;
      if (line.quantity > remaining) {
        return {
          ok: false as const,
          message: `Quantité de retour trop élevée pour « ${item.product_name} » (reste ${Math.max(remaining, 0)}).`,
        };
      }
      requestedByItem.set(line.orderItemId, priorInRequest + line.quantity);
    }

    const [ret] = await tx
      .insert(order_returns)
      .values({
        order_id: d.orderId,
        kind: d.kind,
        status: "pending",
        reason_code: d.reasonCode ?? null,
        reason: d.reason ?? null,
        comment: d.comment ?? null,
        // Carrier metadata is meaningful only for a « Retour d'expédition »;
        // force-null it on an after_sale return so the columns stay clean.
        carrier_name: d.kind === "shipment" ? (d.carrierName ?? null) : null,
        tracking_ref: d.kind === "shipment" ? (d.trackingRef ?? null) : null,
        delivery_attempts: d.kind === "shipment" ? (d.deliveryAttempts ?? null) : null,
        created_by_user_id: actorUserId ?? null,
      })
      .returning({ id: order_returns.id });
    await tx.insert(order_return_items).values(
      d.lines.map((line) => {
        const item = itemById.get(line.orderItemId)!;
        return {
          return_id: ret.id,
          order_item_id: line.orderItemId,
          product_id: item.product_id,
          variant_id: item.variant_id ?? null,
          quantity: line.quantity,
          restockable: line.restockable,
          condition_note: line.conditionNote ?? null,
        };
      }),
    );
    return { ok: true as const, returnId: ret.id };
  });

  if (!result.ok) return fail("validation", result.message);
  await bus.emit(
    "order.return.created",
    { orderId: d.orderId, orderNumber: order.order_number, returnId: result.returnId },
    { actorUserId },
  );
  return ok({ returnId: result.returnId });
});

type RestockLinesOutcome = {
  restocked: number;
  touchedProductIds: string[];
  restockedProductIds: string[];
};

/**
 * Restock every restockable return line that hasn't already restocked, on the
 * caller's `tx`. Idempotent per LINE (`restocked_at`) so re-running never
 * double-restocks; shared-mode variant lines restock the parent pool; untracked
 * / soft-deleted rows are skipped; each real change writes a `return` movement.
 * Shared by BOTH receive flows (after_sale + the « Retour d'expédition »), which
 * is why it lives apart from the status/cancel bookkeeping.
 */
async function restockReturnLines(
  tx: DbOrTx,
  lines: OrderReturnItemRow[],
  orderId: string,
  opts: { actorUserId?: string | null; sharedDefault: boolean },
): Promise<RestockLinesOutcome> {
  const productIds = [...new Set(lines.map((l) => l.product_id))];
  const modeRows = productIds.length
    ? await tx
        .select({ id: products.id, shared: products.shared_variant_stock })
        .from(products)
        .where(inArray(products.id, productIds))
    : [];
  const sharedById = new Map(modeRows.map((r) => [r.id, r.shared]));
  const sharedOf = (pid: string) => isSharedStock(sharedById.get(pid), opts.sharedDefault);
  // Lock the stock rows in a deterministic global id order so concurrent
  // receives of different returns sharing SKUs can't AB/BA deadlock.
  const ordered = [...lines].sort((a, b) => {
    const ka = a.variant_id && !sharedOf(a.product_id) ? a.variant_id : a.product_id;
    const kb = b.variant_id && !sharedOf(b.product_id) ? b.variant_id : b.product_id;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });

  let restocked = 0;
  const touchedR = new Set<string>();
  const restockedR = new Set<string>(); // crossed sold-out → in stock
  for (const line of ordered) {
    if (!line.restockable || line.restocked_at) continue;
    const shared = sharedOf(line.product_id);

    let resultingQty: number | null = null;
    let changed = false;
    if (line.variant_id && !shared) {
      const r = await tx
        .update(product_variants)
        .set({
          stock_qty: sql`${product_variants.stock_qty} + ${line.quantity}`,
          in_stock: sql`case when ${product_variants.stock_qty} <= 0 then true else ${product_variants.in_stock} end`,
        })
        .where(and(eq(product_variants.id, line.variant_id), sql`${product_variants.stock_qty} IS NOT NULL`, isNull(product_variants.deleted_at)))
        .returning({ stockQty: product_variants.stock_qty });
      if (r.length > 0) { changed = true; resultingQty = r[0].stockQty; }
    } else {
      const r = await tx
        .update(products)
        .set({
          stock_qty: sql`${products.stock_qty} + ${line.quantity}`,
          in_stock: sql`case when ${products.stock_qty} <= 0 then true else ${products.in_stock} end`,
        })
        .where(and(eq(products.id, line.product_id), sql`${products.stock_qty} IS NOT NULL`, isNull(products.deleted_at)))
        .returning({ stockQty: products.stock_qty });
      if (r.length > 0) { changed = true; resultingQty = r[0].stockQty; }
    }

    // Mark the line processed regardless (untracked/deleted = no-op restock),
    // so a re-receive never reprocesses it; ledger only a real stock change.
    await tx.update(order_return_items).set({ restocked_at: sql`now()`, updated_at: sql`now()` }).where(eq(order_return_items.id, line.id));
    if (changed) {
      restocked += 1;
      touchedR.add(line.product_id);
      if (resultingQty != null && resultingQty - line.quantity <= 0 && resultingQty > 0) {
        restockedR.add(line.product_id); // back in stock → waitlist
      }
      // SHARED-pool lines restocked the PARENT row above, so the ledger row is
      // product-level (variant null) with the pool's resulting qty — mirror of
      // place-order / restock.ts, keeping Σ(delta) per (product, variant)
      // reconcilable. The variant stays traceable in the note.
      await stockMovementService.record(
        {
          productId: line.product_id,
          variantId: line.variant_id && !shared ? line.variant_id : null,
          delta: line.quantity,
          resultingQty,
          reason: "return",
          orderId,
          actorUserId: opts.actorUserId,
          note: line.variant_id && shared ? `Variante ${line.variant_id} (stock partagé)` : null,
        },
        tx,
      );
    }
  }

  return { restocked, touchedProductIds: [...touchedR], restockedProductIds: [...restockedR] };
}

/**
 * Mark a return RECEIVED and restock its restockable lines (see
 * `restockReturnLines`). Idempotent; a return already received/rejected is a
 * clean no-op/conflict.
 *
 * SHIPMENT returns (« Retour d'expédition ») additionally CANCEL the order in
 * the SAME transaction: the parcel came back (or was lost), so the order is
 * dead. The physical restock is done HERE (shipped-qty capped, per line) — NOT
 * via the normal cancel path's FULL restock, which is exactly why the standard
 * `shipped → cancelled` transition is blocked (it would double-count goods that
 * left in a bon de livraison). The rest of the cancel's full-undo reconciliation
 * (promotion reversal) still runs via `reconcileOrderPromos`, keeping an RTO
 * cancel consistent with an ordinary one.
 *
 * `orderId` (optional) SCOPES the return to that order: a return of another
 * order reads as not found. The API passes the order from its path so
 * `PATCH /api/orders/A/returns {returnId of B}` can't restock B's return while
 * reporting success for A.
 */
export const receiveReturnWorkflow = workflow<
  [{ returnId: string; orderId?: string }, { actorUserId?: string | null }],
  { returnId: string; restocked: number; cancelledOrder: boolean }
>("order.return.receive", async ({ returnId, orderId }, { actorUserId }) => {
  const sharedDefault = await getSharedStockDefault();
  const result = await db.transaction(async (tx) => {
    const [ret] = await tx.select().from(order_returns).where(eq(order_returns.id, returnId)).for("update").limit(1);
    if (!ret || (orderId !== undefined && ret.order_id !== orderId)) return { error: "not_found" as const };
    if (ret.status === "rejected") return { error: "rejected" as const };
    // Idempotency: a return already 'received' must NOT be re-processed — the
    // per-line `restocked_at` guard already prevents double-restock, but
    // re-running would clobber the original processed_by/processed_at and
    // re-emit order.return.received (duplicate mailing/audit). Short-circuit.
    if (ret.status === "received") return { error: "already_received" as const };

    // « Retour d'expédition » (RTO): resolve + GUARD the order cancel BEFORE any
    // write. A sentinel `return` from a managed tx COMMITS (only a throw rolls
    // back), so a guard placed AFTER the restock/status writes is not a guard —
    // it would leave phantom stock + a stuck order. We therefore lock the order
    // and re-check it is still `shipped` (the parcel's "bounced back" premise — a
    // concurrent → delivered/refunded invalidates it; refuse rather than restock
    // goods that may be with the customer), before touching stock.
    let orderToCancel: Awaited<ReturnType<typeof orderService.findById>> = null;
    if (ret.kind === "shipment") {
      const order = await orderService.findById(ret.order_id, tx, { forUpdate: true });
      if (!order || order.status !== "shipped") return { error: "not_shipped" as const };
      orderToCancel = order;
    }

    const lines = await tx.select().from(order_return_items).where(eq(order_return_items.return_id, returnId));
    const { restocked, touchedProductIds, restockedProductIds } = await restockReturnLines(
      tx,
      lines,
      ret.order_id,
      { actorUserId, sharedDefault },
    );

    await tx
      .update(order_returns)
      .set({ status: "received", processed_by_user_id: actorUserId ?? null, processed_at: sql`now()`, updated_at: sql`now()` })
      .where(eq(order_returns.id, returnId));

    // The RTO parcel is back (or written off) → cancel the order. The return
    // already restocked the shipped units (above), so this uses the low-level
    // status setter and deliberately does NOT full-restock — exactly why the
    // normal shipped → cancelled transition is blocked. The rest of the cancel's
    // full-undo (promotion reversal) still runs.
    let cancelledOrder = false;
    let fromStatus: string | null = null;
    if (orderToCancel) {
      const updated = await orderService.transitionStatusInTx(
        tx,
        orderToCancel.id,
        "cancelled",
        actorUserId ?? undefined,
        `Retour d'expédition — commande non livrée (retour ${ret.id})`,
      );
      await reconcileOrderPromos(tx, updated ?? orderToCancel);
      cancelledOrder = true;
      fromStatus = orderToCancel.status; // always "shipped" (guarded above)
    }

    return {
      ok: true as const,
      restocked,
      orderId: ret.order_id,
      touchedProductIds,
      restockedProductIds,
      cancelledOrder,
      fromStatus,
    };
  });

  if ("error" in result) {
    if (result.error === "not_found") return fail("not_found", "Retour introuvable.");
    // Already received → idempotent no-op (no event re-emit, no attribution clobber).
    if (result.error === "already_received") return ok({ returnId, restocked: 0, cancelledOrder: false });
    if (result.error === "not_shipped")
      return fail(
        "conflict",
        "La commande n'est plus au statut « Expédiée » — ce retour d'expédition ne peut pas être confirmé. Rechargez la page.",
      );
    return fail("conflict", "Ce retour a été rejeté.");
  }
  const order = await orderService.findById(result.orderId);
  await bus.emit(
    "order.return.received",
    { orderId: result.orderId, orderNumber: order?.order_number ?? "", returnId, restockedItems: result.restocked },
    { actorUserId },
  );
  // RTO cancellation side effects (best-effort, post-commit): the
  // order.status_changed event, so cancellation subscribers (ERP/webhooks, mail)
  // see the shipped → cancelled move.
  if (result.cancelledOrder) {
    await bus.emit(
      "order.status_changed",
      {
        orderId: result.orderId,
        orderNumber: order?.order_number ?? "",
        fromStatus: result.fromStatus ?? "shipped",
        toStatus: "cancelled",
      },
      { actorUserId: actorUserId ?? null },
    );
  }
  // Post-commit: bust catalog cache + back-in-stock waitlist for products the
  // received return returned to sellable stock.
  await emitRestockEvents(
    { touchedProductIds: result.touchedProductIds, restockedProductIds: result.restockedProductIds },
    actorUserId,
  ).catch(() => {});
  return ok({ returnId, restocked: result.restocked, cancelledOrder: result.cancelledOrder });
});

/**
 * Reject a PENDING return (no restock). Runs in a tx that locks the return row
 * FOR UPDATE and re-checks the status under the lock — so a reject racing a
 * concurrent receive can't flip an already-received (restocked) return to
 * rejected (which would make its units re-returnable → double restock). Only a
 * pending return can be rejected; anything else is a clean conflict. Optional
 * `orderId` scopes it to that order, exactly like receiveReturnWorkflow.
 */
export const rejectReturnWorkflow = workflow<
  [{ returnId: string; orderId?: string }, { actorUserId?: string | null }],
  { returnId: string }
>("order.return.reject", async ({ returnId, orderId }, { actorUserId }) => {
  const outcome = await db.transaction(async (tx) => {
    const [ret] = await tx.select().from(order_returns).where(eq(order_returns.id, returnId)).for("update").limit(1);
    if (!ret || (orderId !== undefined && ret.order_id !== orderId)) return { status: "not_found" as const };
    if (ret.status !== "pending") return { status: "conflict" as const };
    await tx
      .update(order_returns)
      .set({ status: "rejected", processed_by_user_id: actorUserId ?? null, processed_at: sql`now()`, updated_at: sql`now()` })
      .where(eq(order_returns.id, returnId));
    return { status: "ok" as const, orderId: ret.order_id };
  });
  if (outcome.status === "not_found") return fail("not_found", "Retour introuvable.");
  if (outcome.status === "conflict") return fail("conflict", "Ce retour est déjà traité (reçu ou rejeté).");
  const order = await orderService.findById(outcome.orderId);
  await bus.emit(
    "order.return.rejected",
    { orderId: outcome.orderId, orderNumber: order?.order_number ?? "", returnId },
    { actorUserId },
  );
  return ok({ returnId });
});
