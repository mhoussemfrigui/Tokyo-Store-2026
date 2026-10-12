import "server-only";

import { z } from "zod";

import { db } from "@/lib/db/client";
import { orderService } from "@/modules/order/service";
import { documentService, DOCUMENT_PREFIX_DEFAULTS } from "@/modules/document";
import { getSettingsMap } from "@/modules/cms/setting/queries";
import { fiscalYear } from "@/lib/fiscal-period";
import { orderTransitionsFor, type OrderStatus } from "@/lib/order/status";
import { isFullyRefunded, sumRefundCents } from "@/lib/order/fulfilment-state";
import { bus } from "@/events/bus";
import { fail, ok, workflow } from "../shared";
import type { WorkflowFail } from "../shared";

/** Statuses from which a parcel may be shipped (online order must be past pending). */
const SHIPPABLE = new Set(["paid", "preparing", "shipped"]);

const createShipmentSchema = z.object({
  orderId: z.string().uuid(),
  lines: z
    .array(z.object({ orderItemId: z.string().uuid(), quantity: z.number().int().positive() }))
    .min(1),
  deliveryMethod: z.enum(["home_delivery", "drive_by_pickup", "in_store"]).nullable().optional(),
  deliveryAgentName: z.string().trim().optional(),
  trackingRef: z.string().trim().optional(),
  notes: z.string().trim().optional(),
  /** When this shipment completes the order, also transition it to "shipped". */
  markShipped: z.boolean().optional(),
});

function prefixOf(raw: string | null | undefined, fallback: string): string {
  const cleaned = (raw ?? "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  return cleaned.slice(0, 8) || fallback;
}

/**
 * Create one partial-shipment bon de livraison: a parcel covering a subset of
 * order-line quantities, with its own gapless BL number (same `delivery_note`
 * counter as the whole-order BL). Enforced under the order lock: status must be
 * shippable; the order must not be fully refunded (its unshipped units were
 * restocked by the refund); and no line may be over-shipped (already +
 * requested ≤ qty).
 * When `markShipped` and every line is fully shipped, transitions the order to
 * "shipped" (if the graph allows) + emits order.status_changed; always emits
 * order.shipment_created so a tracking email / ERP push sees each parcel.
 */
export const createShipmentWorkflow = workflow<
  [z.input<typeof createShipmentSchema>, { actorUserId?: string | null }],
  { orderId: string; shipmentId: string; deliveryNoteNumber: string; fullyShipped: boolean }
>("order.shipment.create", async (input, { actorUserId }) => {
  const parsed = createShipmentSchema.safeParse(input);
  if (!parsed.success) return fail("validation", "Expédition invalide.");
  const d = parsed.data;

  const settings = await getSettingsMap().catch(() => ({}) as Record<string, string | null>);
  const prefix = prefixOf(settings["delivery.note_prefix"], DOCUMENT_PREFIX_DEFAULTS.delivery_note);
  const period = fiscalYear(); // store-tz fiscal year, not raw UTC (see fiscal-period.ts)

  const result = await db.transaction<
    | { kind: "ok"; shipmentId: string; deliveryNoteNumber: string; fullyShipped: boolean; transitioned: boolean; orderNumber: string; fromStatus: string }
    | { kind: "fail"; error: WorkflowFail }
  >(async (tx) => {
    const order = await orderService.findById(d.orderId, tx, { forUpdate: true });
    if (!order) return { kind: "fail", error: fail("not_found", "Commande introuvable.") };
    if (!SHIPPABLE.has(order.status)) {
      return { kind: "fail", error: fail("invalid_status", "La commande n'est pas dans un état expédiable (payée / en préparation).") };
    }
    // A FULL refund already put every still-unshipped unit back into sellable
    // stock (refund-order.ts restocks the unshipped remainder) without changing
    // the status — shipping those units now would move goods the stock counter
    // says are on the shelf (and that the customer was refunded for).
    const refundedCents = sumRefundCents(await orderService.listRefunds(d.orderId, tx));
    if (isFullyRefunded(order.total_cents, refundedCents)) {
      return {
        kind: "fail",
        error: fail(
          "conflict",
          "Commande intégralement remboursée — son stock non expédié a déjà été réintégré, aucune nouvelle expédition n'est possible.",
        ),
      };
    }

    const lines = await orderService.listItemsInTx(tx, d.orderId);
    const lineById = new Map(lines.map((l) => [l.id, l]));
    const shippedByItem = await orderService.shippedQtyByItem(d.orderId, tx);

    // Dedup requested lines + validate belonging + over-ship.
    const requested = new Map<string, number>();
    for (const l of d.lines) {
      const line = lineById.get(l.orderItemId);
      if (!line) return { kind: "fail", error: fail("validation", "Ligne de commande introuvable pour cette expédition.") };
      const prior = requested.get(l.orderItemId) ?? 0;
      const already = shippedByItem.get(l.orderItemId) ?? 0;
      if (already + prior + l.quantity > line.quantity) {
        return { kind: "fail", error: fail("exceeds_remaining", `Quantité demandée dépasse le restant à expédier pour « ${line.product_name} » (restant ${Math.max(line.quantity - already - prior, 0)}).`) };
      }
      requested.set(l.orderItemId, prior + l.quantity);
    }

    const number = await documentService.nextNumber("delivery_note", { prefix, period }, tx);
    const shipment = await orderService.insertShipment(
      {
        order_id: d.orderId,
        delivery_note_number: number,
        delivery_method: d.deliveryMethod ?? null,
        delivery_agent_name: d.deliveryAgentName ?? null,
        tracking_ref: d.trackingRef ?? null,
        shipped_at: new Date(),
        created_by_user_id: actorUserId ?? null,
        notes: d.notes ?? null,
      } as never,
      tx,
    );
    await orderService.insertShipmentItems(
      [...requested.entries()].map(([orderItemId, quantity]) => ({ shipment_id: shipment.id, order_item_id: orderItemId, quantity })) as never,
      tx,
    );

    // Fully shipped? Every line's shipped (incl. this parcel) ≥ its quantity.
    const fullyShipped = lines.every((l) => (shippedByItem.get(l.id) ?? 0) + (requested.get(l.id) ?? 0) >= l.quantity);

    // Mark shipped when the whole order has now left. `shipped` is reachable
    // from `preparing` in both graphs; from `paid` (online order shipped before
    // the operator clicked "préparer") advance paid→preparing→shipped in-tx so
    // the order can't strand in `paid` while fully shipped.
    let transitioned = false;
    if (d.markShipped && fullyShipped) {
      if (order.status === "paid") {
        await orderService.transitionStatusInTx(tx, d.orderId, "preparing", actorUserId ?? undefined, `Préparation (BL ${number})`);
        await orderService.transitionStatusInTx(tx, d.orderId, "shipped", actorUserId ?? undefined, `Expédition complète (BL ${number})`);
        transitioned = true;
      } else if (orderTransitionsFor(order.status as OrderStatus, order.payment_method, order.delivery_method).includes("shipped")) {
        await orderService.transitionStatusInTx(tx, d.orderId, "shipped", actorUserId ?? undefined, `Expédition complète (BL ${number})`);
        transitioned = true;
      }
    }

    return { kind: "ok", shipmentId: shipment.id, deliveryNoteNumber: number, fullyShipped, transitioned, orderNumber: order.order_number, fromStatus: order.status };
  });

  if (result.kind === "fail") return result.error;

  if (result.transitioned) {
    // The inline transition (transitionStatusInTx) doesn't emit on its own —
    // mirror transition-status's post-commit emit so the "shipped" mail fires.
    // fromStatus is the order's REAL prior status (paid or preparing).
    await bus.emit(
      "order.status_changed",
      { orderId: d.orderId, orderNumber: result.orderNumber, fromStatus: result.fromStatus, toStatus: "shipped" },
      { actorUserId: actorUserId ?? null },
    );
  }
  await bus.emit(
    "order.shipment_created",
    { orderId: d.orderId, orderNumber: result.orderNumber, shipmentId: result.shipmentId, deliveryNoteNumber: result.deliveryNoteNumber, trackingRef: d.trackingRef ?? null },
    { actorUserId: actorUserId ?? null },
  );

  return ok({ orderId: d.orderId, shipmentId: result.shipmentId, deliveryNoteNumber: result.deliveryNoteNumber, fullyShipped: result.fullyShipped });
});
