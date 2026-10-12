import "server-only";

import { eq, sql } from "drizzle-orm";

import { db, type DbOrTx } from "@/lib/db/client";
import { orders } from "@/modules/order/schema";
import { orderService } from "@/modules/order/service";
import { documentService, DOCUMENT_PREFIX_DEFAULTS } from "@/modules/document";
import { getSettingsMap } from "@/modules/cms/setting/queries";
import { fiscalYear } from "@/lib/fiscal-period";

/** Sanitize an operator-set prefix to A–Z/0–9, fall back to the default. */
function prefixOf(raw: string | null | undefined, fallback: string): string {
  const cleaned = (raw ?? "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  return cleaned.slice(0, 8) || fallback;
}

/**
 * Idempotently stamp the whole-order bon de livraison number on an order.
 *
 * Gapless + race-safe: the order row is locked `FOR UPDATE` and the sequence
 * bump runs in the SAME transaction that stamps the number, so a rollback
 * unwinds the bump (no burnt numbers). Idempotent — an order that already has a
 * `delivery_note_number` (issued manually via the Documents panel, or by a prior
 * call) is returned unchanged with `issued: false`.
 *
 * Single source of truth shared by the manual `issueDeliveryNoteAction` and the
 * automatic issue-on-ship subscriber, so both paths use identical prefix/period
 * numbering. Pass a `tx` to enlist in an existing transaction; omit it to run
 * standalone.
 *
 * `opts.skipIfShipments` (the automatic path): an order fulfilled through
 * parcels already carries one BL per parcel (`shipments.delivery_note_number`,
 * drawn from the SAME counter) — a whole-order BL on top would burn a second
 * number for the same goods. Checked under the order lock (create-shipment
 * takes the same lock), and returns `null` without issuing.
 *
 * Returns `null` when the order doesn't exist (or was skipped, see above).
 */
export async function ensureOrderDeliveryNoteNumber(
  orderId: string,
  tx?: DbOrTx,
  opts?: { skipIfShipments?: boolean },
): Promise<{ number: string; orderNumber: string; issued: boolean } | null> {
  const settings = await getSettingsMap().catch(
    () => ({}) as Record<string, string | null>,
  );
  const prefix = prefixOf(settings["delivery.note_prefix"], DOCUMENT_PREFIX_DEFAULTS.delivery_note);
  const period = fiscalYear();

  const run = async (t: DbOrTx) => {
    const order = await orderService.findById(orderId, t, { forUpdate: true });
    if (!order) return null;
    if (order.delivery_note_number) {
      return { number: order.delivery_note_number, orderNumber: order.order_number, issued: false };
    }
    if (opts?.skipIfShipments && (await orderService.countShipments(orderId, t)) > 0) {
      return null;
    }
    const number = await documentService.nextNumber("delivery_note", { prefix, period }, t);
    await t
      .update(orders)
      .set({ delivery_note_number: number, delivery_note_at: sql`now()`, updated_at: sql`now()` })
      .where(eq(orders.id, orderId));
    return { number, orderNumber: order.order_number, issued: true };
  };

  return tx ? run(tx) : db.transaction(run);
}
