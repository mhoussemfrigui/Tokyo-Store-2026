import "server-only";

import { and, asc, count, desc, eq, gte, ilike, inArray, isNotNull, isNull, lt, or, sql, type SQL } from "drizzle-orm";

import { db, type DbOrTx, type Tx } from "@/lib/db/client";
import { parseIncrementalCursor, UUID_RE } from "@/lib/api/cursor";
import { keysetAfter, keysetCursor, settledBefore } from "@/lib/api/keyset";
import { isUpfrontPaidMethod } from "@/lib/order/status";
import { ONLINE_METHODS } from "@/lib/payments/shared";
import {
  order_items,
  order_care_items,
  order_refunds,
  order_status_history,
  orders,
  shipments,
  shipment_items,
  type NewOrderCareItemRow,
  type NewOrderItemRow,
  type NewOrderRefundRow,
  type NewOrderRow,
  type NewShipmentItemRow,
  type NewShipmentRow,
  type OrderCareItemRow,
  type OrderItemRow,
  type OrderRefundRow,
  type OrderRow,
  type OrderStatus,
  type OrderChannel,
  type ShipmentItemRow,
  type ShipmentRow,
} from "./schema";
import { order_returns, order_return_items } from "./returns.schema";
import { actionableOrderSql, netRevenueCentsSql, revenueOrderSql } from "./queries";
import { products } from "@/modules/catalog/product/schema";

/**
 * Base filters shared by the admin list and its chip counts: guest-only, and a
 * single search term ORed across number + email + phone (one OR group, not
 * separate AND'd conditions) so "CMD-7K9P2X", an email fragment, or a phone
 * fragment each match. `phone` is kept as an explicit alias for callers that
 * pass it separately; it folds into the SAME OR so it never AND-excludes.
 */
function listBaseConditions(opts: {
  search?: string;
  guestOnly?: boolean;
  phone?: string;
  /** Spam-triage scope: undefined/false → HIDE flagged-spam rows (the default
   *  Commandes view); true → show ONLY flagged-spam rows (the « Spam » filter). */
  spam?: boolean;
}): SQL[] {
  const conditions: SQL[] = [];
  // The default list hides spam; the « Spam » filter inverts to show only spam.
  conditions.push(opts.spam ? isNotNull(orders.flagged_spam_at) : isNull(orders.flagged_spam_at));
  if (opts.guestOnly) conditions.push(isNull(orders.user_id));
  const term = opts.search?.trim() || opts.phone?.trim();
  if (term) {
    conditions.push(
      or(
        ilike(orders.order_number, `%${term}%`),
        ilike(orders.contact_email, `%${term}%`),
        // contact_phone is nullable — ilike yields NULL (filtered) on rows without one.
        ilike(orders.contact_phone, `%${term}%`),
      )!,
    );
  }
  return conditions;
}

/**
 * « Has at least one AFTER-SALE return (SAV) » — rides `order_returns_order_idx`.
 * Scoped to `kind='after_sale'` so a « Retour d'expédition » (RTO) bounce never
 * lights the SAV badge / « Retours » quick-filter (those live on their own tab);
 * the RTO surfaces under Retours → Retour d'expédition instead.
 */
function hasReturnSql(): SQL {
  return sql`EXISTS (SELECT 1 FROM ${order_returns} r WHERE r.order_id = ${orders.id} AND r.kind = 'after_sale')`;
}

/**
 * Strictly-before predicate for the admin list's `(created_at, id)` DESC keyset,
 * from a `<µs ISO ts>|<id>` cursor. The timestamp is bound as a RAW string cast
 * `::timestamptz` (a JS Date would truncate µs → ms and re-match the boundary),
 * after the same validation the API cursors use; anything malformed → no
 * predicate (first page).
 */
function listCursorCondition(cursor: string | undefined): SQL | undefined {
  if (!cursor) return undefined;
  const sep = cursor.lastIndexOf("|");
  if (sep <= 0) return undefined;
  const curTs = cursor.slice(0, sep);
  const curId = cursor.slice(sep + 1);
  const ts = parseIncrementalCursor(new URLSearchParams({ since: curTs }));
  if (!ts.ok || !ts.sinceIso || !UUID_RE.test(curId)) return undefined;
  return sql`(${orders.created_at} < ${ts.sinceIso}::timestamptz OR (${orders.created_at} = ${ts.sinceIso}::timestamptz AND ${orders.id} < ${curId}::uuid))`;
}

class OrderService {
  async findById(
    id: string,
    txOrDb: DbOrTx = db,
    opts?: { forUpdate?: boolean },
  ): Promise<OrderRow | null> {
    const q = txOrDb.select().from(orders).where(eq(orders.id, id)).limit(1);
    const [row] = await (opts?.forUpdate ? q.for("update") : q);
    return row ?? null;
  }

  /**
   * Online-payment orders stuck `pending` within the window
   * [`minMinutes`, `maxHours`] that carry a gateway reference — candidates for
   * the reconcile cron (rescues a customer who closed the return tab before
   * settlement, and an order stranded by a crash between the webhook_events
   * claim-commit and the status transition).
   *
   * NEWEST-stuck first + an upper `maxHours` bound so a large backlog of
   * genuinely-abandoned old orders can't starve a freshly-stuck (just-closed-tab)
   * one out of the capped batch. The ceiling is sound because every gateway
   * session expires within ~20-30 min (Flouci/ClicToPay), so an order
   * pending beyond a few hours will never settle anyway. Rides
   * `orders_updated_at_idx`.
   */
  async listStalePendingOnline(minMinutes: number, maxHours: number, limit = 100): Promise<OrderRow[]> {
    return db
      .select()
      .from(orders)
      .where(
        and(
          eq(orders.status, "pending"),
          isNotNull(orders.payment_reference),
          inArray(orders.payment_method, [...ONLINE_METHODS]),
          lt(orders.updated_at, sql`now() - make_interval(mins => ${minMinutes})`),
          gte(orders.updated_at, sql`now() - make_interval(hours => ${maxHours})`),
        ),
      )
      .orderBy(desc(orders.updated_at))
      .limit(limit);
  }

  /**
   * Orders stuck `pending` past `olderThanHours` — abandoned-checkout candidates
   * for the sweep cron. This is the GENERIC stock-release backstop the
   * payment-reconcile cron does NOT cover: UNCONFIRMED COD orders (no gateway
   * flow), online orders that never got a gateway reference (initiate never
   * ran), and any order aged out of the reconcile window. Stock is reserved at
   * placement, so these silently hold inventory until cancelled. OLDEST first;
   * bounded. The window is chosen well beyond any live gateway session so it
   * never races reconcile.
   *
   * NEVER candidates — orders someone has taken charge of, which stay pending by
   * design until an operator advances or cancels them:
   *   • operator-CONFIRMED orders (`confirmed_at` set) — a COD order keeps its
   *     `pending` status after « Confirmer la commande » (À préparer); the
   *     customer was told it's accepted, so it must not be auto-cancelled;
   *   • ERP-pushed orders (`external_ref` set) — owned by the external system;
   *   • point-less counter sales (`in_store` / `drive_by_pickup` with NO pickup
   *     point) settled offline — e.g. a caisse sale left « Non payé ». Only
   *     those are exempt: a pickup naming a point (a shopper's « Retrait en
   *     magasin / Drive » order, or a manual order with a point) is swept like a
   *     home COD order, and a pickup paid through an ONLINE gateway is always
   *     swept (an abandoned gateway session is exactly what this backstop is
   *     for). The point is read from the frozen `pickup_location_name` snapshot,
   *     which survives the point's deletion (`pickup_location_id` is ON DELETE
   *     SET NULL).
   */
  async listAbandonedPending(olderThanHours: number, limit = 200): Promise<OrderRow[]> {
    return db
      .select()
      .from(orders)
      .where(
        and(
          eq(orders.status, "pending"),
          isNull(orders.confirmed_at),
          // A PAID order is never abandoned — an operator who hand-marked a COD
          // order paid (paid_at set) without yet advancing it to « En préparation »
          // must not have it auto-cancelled + restocked after 48 h. (Online captures
          // with a gateway reference are additionally guarded by the sweep's
          // assertPendingOnlineOrderNotCaptured pre-flight; this also covers COD /
          // no-reference manual payments, which short-circuit that pre-flight.)
          isNull(orders.paid_at),
          isNull(orders.external_ref),
          or(
            eq(orders.delivery_method, "home_delivery"),
            inArray(orders.payment_method, [...ONLINE_METHODS]),
            isNotNull(orders.pickup_location_name),
          ),
          lt(orders.updated_at, sql`now() - make_interval(hours => ${olderThanHours})`),
        ),
      )
      .orderBy(asc(orders.updated_at))
      .limit(limit);
  }

  async findByOrderNumber(orderNumber: string): Promise<OrderRow | null> {
    const [row] = await db
      .select()
      .from(orders)
      .where(eq(orders.order_number, orderNumber))
      .limit(1);
    return row ?? null;
  }

  async findByPaymentReference(ref: string, method?: string): Promise<OrderRow | null> {
    // Optionally scope by payment_method so a webhook from provider A can't match
    // an order paid via provider B that happens to share a reference string
    // (gateway refs are effectively unique, but there's no DB guarantee, and
    // admin-set offline refs aren't unique). The webhook handler passes its
    // provider; confirmPayment then re-verifies against the order's method too.
    const [row] = await db
      .select()
      .from(orders)
      .where(
        method
          ? and(eq(orders.payment_reference, ref), eq(orders.payment_method, method as never))
          : eq(orders.payment_reference, ref),
      )
      .limit(1);
    return row ?? null;
  }

  async listItems(orderId: string): Promise<OrderItemRow[]> {
    return db.select().from(order_items).where(eq(order_items.order_id, orderId));
  }

  /** Tx-aware item list — used by the line-edit workflow under the order lock. */
  async listItemsInTx(tx: Tx, orderId: string): Promise<OrderItemRow[]> {
    return tx.select().from(order_items).where(eq(order_items.order_id, orderId));
  }

  /** Patch a line's quantity + recomputed money (operator line edit). */
  async updateItemQuantity(
    orderItemId: string,
    patch: { quantity: number; subtotalCents: number; taxCents: number },
    tx: Tx,
  ): Promise<OrderItemRow | null> {
    const [row] = await tx
      .update(order_items)
      .set({
        quantity: patch.quantity,
        subtotal_cents: patch.subtotalCents,
        tax_cents: patch.taxCents,
        updated_at: sql`now()`,
      })
      .where(eq(order_items.id, orderItemId))
      .returning();
    return row ?? null;
  }

  /** Hard-delete one order line (operator removed it). Returns true if removed. */
  async deleteItem(orderItemId: string, tx: Tx): Promise<boolean> {
    const rows = await tx
      .delete(order_items)
      .where(eq(order_items.id, orderItemId))
      .returning({ id: order_items.id });
    return rows.length > 0;
  }

  /** Patch order money totals after a line edit (subtotal/tax/total + clamped
   *  discounts + the manual TVA override). Only the money columns are touched.
   *  `taxManualCents` is explicit: a line edit rebuilds the total from the
   *  COMPUTED tax, so an override set for the old lines must be cleared (null)
   *  or every renderer prints a TVA row that no longer adds up to the total. */
  async patchTotals(
    orderId: string,
    patch: {
      subtotalCents: number;
      taxCents: number;
      taxManualCents: number | null;
      totalCents: number;
      discountCents: number;
      /** Reconciled Tokyo Care charge (ex-TVA) — omit to leave `care_cents` as is. */
      careCents?: number;
    },
    tx: Tx,
  ): Promise<OrderRow | null> {
    const [row] = await tx
      .update(orders)
      .set({
        subtotal_cents: patch.subtotalCents,
        tax_cents: patch.taxCents,
        tax_manual_cents: patch.taxManualCents,
        total_cents: patch.totalCents,
        discount_cents: patch.discountCents,
        ...(patch.careCents !== undefined ? { care_cents: patch.careCents } : {}),
        updated_at: sql`now()`,
      })
      .where(eq(orders.id, orderId))
      .returning();
    return row ?? null;
  }

  /** Single order line by id — used to verify an item belongs to a given
   *  order + product before fulfilling it. */
  async findItemById(id: string, txOrDb: DbOrTx = db): Promise<OrderItemRow | null> {
    const [row] = await txOrDb
      .select()
      .from(order_items)
      .where(eq(order_items.id, id))
      .limit(1);
    return row ?? null;
  }

  async insertOrder(input: NewOrderRow, txOrDb: DbOrTx = db): Promise<OrderRow> {
    const [row] = await txOrDb.insert(orders).values(input).returning();
    return row;
  }

  /**
   * Claim guest orders (`user_id IS NULL`) for a user by their VERIFIED/vouched
   * email (case-insensitive). The EMAIL match is the security gate — the caller
   * MUST have established that the account owns this mailbox (the
   * post-verification hook, where the link proves ownership; or an admin
   * create/invite, where the operator vouches). Phone is deliberately NOT
   * required: phone is optional at signup, and a guest who checked out without a
   * phone (or whose account has none) must still have their history merged —
   * the previous email-AND-phone gate silently dropped every phone-less order
   * (orphaning order history despite a proven email). Returns the claimed rows.
   * Backed by the `orders_contact_email_lower_idx` functional index.
   */
  async claimGuestOrders(
    opts: { userId: string; email: string },
    txOrDb: DbOrTx = db,
  ): Promise<OrderRow[]> {
    const email = opts.email.trim().toLowerCase();
    if (!email) return [];
    return txOrDb
      .update(orders)
      .set({ user_id: opts.userId, updated_at: sql`now()` })
      .where(and(isNull(orders.user_id), sql`lower(${orders.contact_email}) = ${email}`))
      .returning();
  }

  /**
   * Attach a single guest order to an auth user — the admin "link" feature.
   * Unconditionally sets `user_id` (no phone/email gate, unlike the
   * self-service `claimGuestOrders`): the admin has already decided this order
   * belongs to the account. Returns the updated row, or null if no such order.
   */
  async linkOrderToUser(
    orderId: string,
    userId: string,
    txOrDb: DbOrTx = db,
  ): Promise<OrderRow | null> {
    // Atomic guard: only link an order that is STILL a guest order
    // (user_id IS NULL). If a concurrent self-claim/link already attached it,
    // this updates 0 rows and returns null — so an account order can never be
    // re-assigned, even under a race (no separate check-then-write window).
    const [row] = await txOrDb
      .update(orders)
      .set({ user_id: userId, updated_at: sql`now()` })
      .where(and(eq(orders.id, orderId), isNull(orders.user_id)))
      .returning();
    return row ?? null;
  }

  async insertItems(input: NewOrderItemRow[], txOrDb: DbOrTx = db): Promise<OrderItemRow[]> {
    if (input.length === 0) return [];
    return txOrDb.insert(order_items).values(input).returning();
  }

  /** Insert the Tokyo Care snapshot rows for an order (one per protected line). */
  async insertCareItems(input: NewOrderCareItemRow[], txOrDb: DbOrTx = db): Promise<void> {
    if (input.length === 0) return;
    await txOrDb.insert(order_care_items).values(input);
  }

  /** Every Tokyo Care snapshot row for an order (for the order detail + invoice). */
  async listCareItems(orderId: string, txOrDb: DbOrTx = db): Promise<OrderCareItemRow[]> {
    return txOrDb.select().from(order_care_items).where(eq(order_care_items.order_id, orderId));
  }

  /** Delete care snapshot rows by id — used when an order-line edit removes the
   *  goods line(s) a plan rode on (order_care_items is FK-free, so it's explicit). */
  async deleteCareItems(ids: string[], tx: Tx): Promise<void> {
    if (ids.length === 0) return;
    await tx.delete(order_care_items).where(inArray(order_care_items.id, ids));
  }

  /** Re-quantify a care snapshot row after a line's quantity changed (per-unit
   *  charging): new line total, qty + its re-derived TVA. */
  async updateCareItem(
    id: string,
    patch: { careCents: number; quantity: number; taxCents: number },
    tx: Tx,
  ): Promise<void> {
    await tx
      .update(order_care_items)
      .set({
        care_cents: patch.careCents,
        quantity: patch.quantity,
        tax_cents: patch.taxCents,
        updated_at: sql`now()`,
      })
      .where(eq(order_care_items.id, id));
  }

  /**
   * Toggle the operator pick/pack stamp on one order line. Stamps `picked_at`
   * (now) when picked, clears it otherwise. Scoped to `orderId` — a line id
   * from another order matches nothing — and returns the parent order_id, or
   * null when no such line exists ON THAT ORDER.
   */
  async setItemPicked(
    orderId: string,
    orderItemId: string,
    picked: boolean,
    txOrDb: DbOrTx = db,
  ): Promise<string | null> {
    const [row] = await txOrDb
      .update(order_items)
      .set({ picked_at: picked ? sql`now()` : null, updated_at: sql`now()` })
      .where(and(eq(order_items.id, orderItemId), eq(order_items.order_id, orderId)))
      .returning({ orderId: order_items.order_id });
    return row?.orderId ?? null;
  }

  /**
   * Stamp the gateway tx id on an order. Called by the status-transition
   * workflow when a webhook delivers a payment confirmation, and by the
   * admin "set payment reference" form (for wire transfers and the like).
   * `paymentMethod` is optional so the webhook path can leave it untouched.
   *
   * Accepts an optional tx so callers running this inside a larger atomic
   * boundary (the transition-status workflow, place-order) can stay in
   * the same transaction.
   */
  async updatePaymentReference(
    orderId: string,
    paymentReference: string,
    paymentMethod?: string | null,
    txOrDb: DbOrTx = db,
  ): Promise<OrderRow | null> {
    const patch: Record<string, unknown> = {
      payment_reference: paymentReference,
      updated_at: sql`now()`,
    };
    if (paymentMethod !== undefined) patch.payment_method = paymentMethod;
    const [row] = await txOrDb
      .update(orders)
      .set(patch)
      .where(eq(orders.id, orderId))
      .returning();
    return row ?? null;
  }

  /**
   * Convert a stuck PENDING online-gateway order to cash-on-delivery. Sets
   * `payment_method = 'cod'` AND CLEARS `payment_reference`: the abandoned gateway
   * session is definitively dead (the caller verified it via
   * assertPendingOnlineOrderNotCaptured), so severing the reference stops any late
   * gateway signal from matching this now-COD order by reference. The order stays
   * `pending` and now follows the COD graph (settles at delivery). Caller-tx aware.
   */
  async switchToCod(orderId: string, txOrDb: DbOrTx = db): Promise<OrderRow | null> {
    const [row] = await txOrDb
      .update(orders)
      .set({ payment_method: "cod", payment_reference: null, updated_at: sql`now()` })
      .where(eq(orders.id, orderId))
      .returning();
    return row ?? null;
  }

  /**
   * Flag / unflag an order as spam (triage). `spam` true stamps `flagged_spam_at`
   * (now) + the actor; false clears both. A flagged order drops out of the default
   * list + the « À traiter » queue. Caller-tx aware; returns the updated row.
   */
  async setSpam(
    orderId: string,
    spam: boolean,
    actorUserId: string | null,
    txOrDb: DbOrTx = db,
  ): Promise<OrderRow | null> {
    const [row] = await txOrDb
      .update(orders)
      .set({
        flagged_spam_at: spam ? sql`now()` : null,
        flagged_spam_by_user_id: spam ? actorUserId : null,
        updated_at: sql`now()`,
      })
      .where(eq(orders.id, orderId))
      .returning();
    return row ?? null;
  }

  /**
   * Applies a status transition + appends a row to `order_status_history`,
   * staying inside the caller's transaction (no nested `txOrDb.transaction`
   * call). Used by workflows that orchestrate `updatePaymentReference` +
   * status transition + extra checks (e.g. delivered -> refunded only if a
   * refund row exists) in the same atomic boundary.
   */
  async transitionStatusInTx(
    tx: Tx,
    orderId: string,
    toStatus: OrderStatus,
    actorUserId?: string,
    notes?: string,
  ): Promise<OrderRow | null> {
    const [existing] = await tx
      .select()
      .from(orders)
      .where(eq(orders.id, orderId))
      .limit(1);
    if (!existing) return null;
    // Stamp the payment-settlement time once: online orders settle on `paid`;
    // COD (and other non-gateway) orders settle at `delivered` (cash collected).
    // Never overwrite an existing timestamp.
    const settlesPaymentNow =
      existing.paid_at == null &&
      (toStatus === "paid" ||
        (toStatus === "delivered" && !isUpfrontPaidMethod(existing.payment_method)));
    // Auto-confirm: an order is implicitly confirmed once it settles online
    // (→ paid) or advances into fulfilment (preparing/shipped/delivered). This
    // back-stops the explicit COD "Confirmer" action so the stepper can never
    // show a later step lit while "Confirmée" is not. Never overwrite an
    // existing confirmation. (COD pending → manual confirm sets it directly.)
    const confirmsNow =
      existing.confirmed_at == null &&
      (toStatus === "paid" ||
        toStatus === "preparing" ||
        toStatus === "shipped" ||
        toStatus === "delivered");
    const [updated] = await tx
      .update(orders)
      .set({
        status: toStatus,
        paid_at: settlesPaymentNow ? sql`now()` : existing.paid_at,
        confirmed_at: confirmsNow ? sql`now()` : existing.confirmed_at,
        updated_at: sql`now()`,
      })
      .where(eq(orders.id, orderId))
      .returning();
    await tx.insert(order_status_history).values({
      order_id: orderId,
      from_status: existing.status,
      to_status: toStatus,
      actor_user_id: actorUserId ?? null,
      notes: notes ?? null,
    });
    return updated ?? null;
  }

  /**
   * « Paiement manuel » — set the order's payment settlement directly (NOT a
   * status change): `paid_at` (a Date to mark paid now, or null to un-settle)
   * plus the recorded `amount_paid_cents` (a partial amount, or null). Appends an
   * audit row to `order_status_history` (from = to = the UNCHANGED status) so the
   * timeline shows the manual payment change. Caller runs the promo reconcile
   * + events around this. Stays inside the caller's tx.
   */
  async setManualPaymentInTx(
    tx: Tx,
    orderId: string,
    opts: { paidAt: Date | null; amountPaidCents: number | null; note: string; actorUserId?: string | null },
  ): Promise<OrderRow | null> {
    const [existing] = await tx.select().from(orders).where(eq(orders.id, orderId)).limit(1);
    if (!existing) return null;
    const [updated] = await tx
      .update(orders)
      .set({
        paid_at: opts.paidAt,
        amount_paid_cents: opts.amountPaidCents,
        updated_at: sql`now()`,
      })
      .where(eq(orders.id, orderId))
      .returning();
    await tx.insert(order_status_history).values({
      order_id: orderId,
      from_status: existing.status,
      to_status: existing.status, // payment change only — the fulfilment status is unchanged
      actor_user_id: opts.actorUserId ?? null,
      notes: opts.note,
    });
    return updated ?? null;
  }

  /**
   * Stamp `confirmed_at` WITHOUT changing the order status — the operator
   * "Confirmer la commande" action (COD orders that are placed/awaiting
   * acceptance). Idempotent: returns the row unchanged if already confirmed. No
   * order_status_history row is written (the status didn't change, and a
   * same-status entry would render confusingly on the customer trail); the
   * confirmation moment lives on `confirmed_at` + the `order.confirmed` event.
   */
  async confirmOrderInTx(
    tx: Tx,
    orderId: string,
    _actorUserId?: string,
  ): Promise<OrderRow | null> {
    const [existing] = await tx
      .select()
      .from(orders)
      .where(eq(orders.id, orderId))
      .limit(1);
    if (!existing) return null;
    if (existing.confirmed_at != null) return existing; // already confirmed
    const [updated] = await tx
      .update(orders)
      .set({ confirmed_at: sql`now()`, updated_at: sql`now()` })
      .where(eq(orders.id, orderId))
      .returning();
    return updated ?? null;
  }

  /**
   * Tx-aware variant of `listRefunds` — used to check refund existence
   * inside the same transaction as a status transition (delivered ->
   * refunded must only succeed when a refund row exists).
   */
  async listRefundsInTx(tx: Tx, orderId: string): Promise<OrderRefundRow[]> {
    return tx
      .select()
      .from(order_refunds)
      .where(eq(order_refunds.order_id, orderId))
      .orderBy(asc(order_refunds.created_at));
  }

  /**
   * The admin Commandes list, newest first, one keyset page at a time. Every
   * filter runs SERVER-side — status chip, « À traiter » queue, « Retours » —
   * so an order older than the loaded page is still reachable from its chip
   * (they used to filter only the 50 newest rows in the browser). Paged on the
   * `(created_at, id)` DESC keyset with a µs-faithful cursor (`<ts>|<id>`, the
   * shape of `listOrdersForExport`): a millisecond `created_at`-only cursor
   * skipped orders sharing the boundary row's millisecond. A malformed cursor
   * (hand-edited URL) is ignored → first page, never cast into a 22007/22P02.
   */
  async list(opts: {
    status?: OrderStatus;
    /** Only the « À traiter » queue — `actionableOrderSql`, the SQL twin of
     *  `isActionableOrder` (same rule as `stats().actionable`). */
    actionable?: boolean;
    /** Only orders with at least one return (SAV). */
    hasReturn?: boolean;
    search?: string;
    /** Restrict to guest orders (no auth account: `user_id IS NULL`). */
    guestOnly?: boolean;
    /** Case-insensitive contact-phone search (alongside number/email). */
    phone?: string;
    /** « Spam » filter: true shows ONLY flagged-spam orders; default hides them. */
    spam?: boolean;
    /** « Origine / Canal » filter: restrict to one sales channel. */
    channel?: OrderChannel;
    /** « Source » filter: restrict to one marketing source (migration 0198). */
    source?: string;
    limit?: number;
    /** A previous page's `nextCursor`. */
    cursor?: string;
  }): Promise<{ items: OrderRow[]; nextCursor: string | null }> {
    const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 25), 1), 100);
    const conditions = listBaseConditions(opts);
    if (opts.status) conditions.push(eq(orders.status, opts.status));
    if (opts.actionable) conditions.push(actionableOrderSql("orders"));
    if (opts.hasReturn) conditions.push(hasReturnSql());
    // Channel is a plain list-level filter (NOT in listBaseConditions — that base is
    // shared with listFilterCounts, where a channel filter would make every chip
    // report the filtered-to-one count).
    if (opts.channel) conditions.push(eq(orders.channel, opts.channel));
    if (opts.source) conditions.push(eq(orders.source, opts.source));
    const after = listCursorCondition(opts.cursor);
    if (after) conditions.push(after);

    const rows = await db
      .select({ row: orders, cursor: keysetCursor(orders.created_at) })
      .from(orders)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(orders.created_at), desc(orders.id))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const trimmed = hasMore ? rows.slice(0, limit) : rows;
    const last = trimmed[trimmed.length - 1];
    return {
      items: trimmed.map((r) => r.row),
      nextCursor: hasMore && last ? `${last.cursor}|${last.row.id}` : null,
    };
  }

  /**
   * Filter-chip counts for the admin Commandes list, in ONE grouped pass: orders
   * per status, the « À traiter » queue and the orders with a return — over the
   * SAME base filters as `list()` (guest-only + search), so each chip states how
   * many rows it would load. Ignores the status / queue / returns filters
   * themselves (a chip counts what clicking it shows).
   */
  async listFilterCounts(opts: {
    search?: string;
    guestOnly?: boolean;
    phone?: string;
  }): Promise<{
    total: number;
    byStatus: Partial<Record<OrderStatus, number>>;
    /** Orders per sales channel (over the same non-spam base) — the « Origine » chips. */
    byChannel: Partial<Record<OrderChannel, number>>;
    /** Orders per marketing source (migration 0198; NULL sources excluded) — the « Source » chips. */
    bySource: Record<string, number>;
    actionable: number;
    withReturn: number;
    /** Flagged-spam orders (over the same guest/search base) — the « Spam » chip. */
    spam: number;
  }> {
    // The status / channel / actionable / return chips count the NON-spam view (spam
    // is hidden by default); the « Spam » chip counts the flagged set separately.
    const [rows, channelRows, sourceRows, [spamRow]] = await Promise.all([
      db
        .select({
          status: orders.status,
          n: sql<number>`count(*)::int`.mapWith(Number),
          actionable: sql<number>`(count(*) FILTER (WHERE ${actionableOrderSql("orders")}))::int`.mapWith(Number),
          withReturn: sql<number>`(count(*) FILTER (WHERE ${hasReturnSql()}))::int`.mapWith(Number),
        })
        .from(orders)
        .where(and(...listBaseConditions(opts)))
        .groupBy(orders.status),
      db
        .select({ channel: orders.channel, n: sql<number>`count(*)::int`.mapWith(Number) })
        .from(orders)
        .where(and(...listBaseConditions(opts)))
        .groupBy(orders.channel),
      // Marketing source over the same base — the NULL group (storefront/express/
      // erp, which carry no source) is dropped below when building bySource.
      db
        .select({ source: orders.source, n: sql<number>`count(*)::int`.mapWith(Number) })
        .from(orders)
        .where(and(...listBaseConditions(opts)))
        .groupBy(orders.source),
      db
        .select({ n: sql<number>`count(*)::int`.mapWith(Number) })
        .from(orders)
        .where(and(...listBaseConditions({ ...opts, spam: true }))),
    ]);
    const byStatus: Partial<Record<OrderStatus, number>> = {};
    let total = 0;
    let actionable = 0;
    let withReturn = 0;
    for (const r of rows) {
      byStatus[r.status] = r.n;
      total += r.n;
      actionable += r.actionable;
      withReturn += r.withReturn;
    }
    const byChannel: Partial<Record<OrderChannel, number>> = {};
    for (const r of channelRows) byChannel[r.channel] = r.n;
    const bySource: Record<string, number> = {};
    for (const r of sourceRows) if (r.source) bySource[r.source] = r.n;
    return { total, byStatus, byChannel, bySource, actionable, withReturn, spam: spamRow?.n ?? 0 };
  }

  // ───────────────────────────────────────────────── external (ERP) order API
  /**
   * Incremental-sync list + forward cursor for the keyed order API. Filters by
   * status + a cursor on `(updated_at, id)`, ordered updated_at ASC then id ASC.
   * Backed by `orders_updated_at_idx` (index-ordered, early-terminating).
   *
   * Returns the page PLUS a microsecond-faithful composite cursor: `nextSince` =
   * the last row's `updated_at` rendered to µs, `nextId` = its id. With both
   * `sinceIso` + `sinceId` the page is STRICTLY AFTER the cursor —
   * `updated_at > since OR (updated_at = since AND id > sinceId)` — so the
   * boundary row is never re-fetched and progress holds even when rows share an
   * `updated_at`.
   *
   * CRUCIAL: `since` is bound as a `::timestamptz` CAST of the µs ISO cursor, NOT
   * a JS Date — `updated_at` is `timestamptz` (microseconds) but a JS Date is
   * millisecond-only, so a Date cursor would truncate (.123456→.123000) and let
   * the boundary row re-match `updated_at > since`, defeating the keyset (the
   * regression this guards against). The cursor is likewise read via
   * `to_char(… 'US')` so no precision is lost on the way out. A legacy caller
   * passing only `sinceIso` keeps the inclusive `>=` watermark (back-compatible).
   * `sinceIso`/`sinceId` are validated by the route before they reach the casts.
   * Rows younger than the settle window are held back so a late-committing
   * placement can't be skipped (`settleSeconds`, default KEYSET_SETTLE_SECONDS;
   * 0 only for tests). The shared keyset lives in `@/lib/api/keyset`.
   */
  async listForApi(opts: {
    status?: OrderStatus;
    sinceIso?: string;
    sinceId?: string;
    limit?: number;
    settleSeconds?: number;
  }): Promise<{ items: OrderRow[]; nextSince: string | null; nextId: string | null }> {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const conditions = [];
    if (opts.status) conditions.push(eq(orders.status, opts.status));
    const after = keysetAfter(orders.updated_at, orders.id, opts.sinceIso, opts.sinceId);
    if (after) conditions.push(after);
    const settled = settledBefore(orders.updated_at, opts.settleSeconds);
    if (settled) conditions.push(settled);
    const rows = await db
      .select({
        row: orders,
        // µs-faithful cursor — `row.updated_at` becomes a JS Date (ms-only), which
        // would defeat the strict-after keyset above when fed back as `?since=`.
        cursor: keysetCursor(orders.updated_at),
      })
      .from(orders)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(asc(orders.updated_at), asc(orders.id))
      .limit(limit);
    const last = rows.length > 0 ? rows[rows.length - 1] : null;
    return {
      items: rows.map((r) => r.row),
      nextSince: last ? last.cursor : null,
      nextId: last ? last.row.id : null,
    };
  }

  /** Resolve an order by its ERP external reference (unique when set). */
  async findByExternalRef(ref: string, txOrDb: DbOrTx = db): Promise<OrderRow | null> {
    const [row] = await txOrDb.select().from(orders).where(eq(orders.external_ref, ref)).limit(1);
    return row ?? null;
  }

  /** Stamp / clear the ERP external reference (raw write — the link rules +
   *  audit live in the `order.set_external_ref` workflow). */
  async setExternalRef(
    orderId: string,
    externalRef: string | null,
    txOrDb: DbOrTx = db,
  ): Promise<OrderRow | null> {
    const [row] = await txOrDb
      .update(orders)
      .set({ external_ref: externalRef, updated_at: sql`now()` })
      .where(eq(orders.id, orderId))
      .returning();
    return row ?? null;
  }

  /** List partial refunds for an order, oldest first (audit trail order). */
  async listRefunds(orderId: string, txOrDb: DbOrTx = db): Promise<OrderRefundRow[]> {
    return txOrDb
      .select()
      .from(order_refunds)
      .where(eq(order_refunds.order_id, orderId))
      .orderBy(asc(order_refunds.created_at));
  }

  /** Append a partial refund. No validation here — caller decides scope. */
  async insertRefund(input: NewOrderRefundRow, txOrDb: DbOrTx = db): Promise<OrderRefundRow> {
    const [row] = await txOrDb.insert(order_refunds).values(input).returning();
    return row;
  }

  // ─────────────────────────────────────────────── partial shipments (BLs)
  /**
   * Units already shipped per order line — `SUM(shipment_items.quantity)` keyed
   * by order_item_id. The DERIVED shipped-quantity (single source of truth);
   * bounds over-shipping AND edit-removal of a line below what physically left.
   */
  async shippedQtyByItem(orderId: string, txOrDb: DbOrTx = db): Promise<Map<string, number>> {
    const rows = await txOrDb
      .select({
        orderItemId: shipment_items.order_item_id,
        qty: sql<number>`coalesce(sum(${shipment_items.quantity}), 0)::int`.mapWith(Number),
      })
      .from(shipment_items)
      .innerJoin(shipments, eq(shipments.id, shipment_items.shipment_id))
      .where(eq(shipments.order_id, orderId))
      .groupBy(shipment_items.order_item_id);
    return new Map(rows.map((r) => [r.orderItemId, r.qty]));
  }

  // ─────────────────────── batched list-page aggregates (L1 badges)
  /**
   * Total refunded amount (millimes) per order, for a page of order ids. One
   * indexed group-by; orders with no refund are absent from the map (caller
   * treats absent as 0). Mirrors `returnService.orderIdsWithReturns`.
   */
  async refundedByOrder(orderIds: string[]): Promise<Map<string, number>> {
    if (orderIds.length === 0) return new Map();
    const rows = await db
      .select({
        orderId: order_refunds.order_id,
        cents: sql<number>`coalesce(sum(${order_refunds.amount_cents}), 0)::int`.mapWith(Number),
      })
      .from(order_refunds)
      .where(inArray(order_refunds.order_id, orderIds))
      .groupBy(order_refunds.order_id);
    return new Map(rows.map((r) => [r.orderId, r.cents]));
  }

  /**
   * Units already shipped (SUM shipment_items.quantity) per order, for a page of
   * order ids — joined through order_items to reach order_id. The inner join on
   * products drops lines whose product row is gone so the numerator shares the
   * SAME "shippable line" universe as {@link shippableOrderedByOrder}. Drives the
   * partial-shipment badge alongside `shippableOrderedByOrder`.
   */
  async shippedQtyByOrder(orderIds: string[]): Promise<Map<string, number>> {
    if (orderIds.length === 0) return new Map();
    const rows = await db
      .select({
        orderId: order_items.order_id,
        qty: sql<number>`coalesce(sum(${shipment_items.quantity}), 0)::int`.mapWith(Number),
      })
      .from(shipment_items)
      .innerJoin(order_items, eq(order_items.id, shipment_items.order_item_id))
      .innerJoin(products, eq(products.id, order_items.product_id))
      .where(inArray(order_items.order_id, orderIds))
      .groupBy(order_items.order_id);
    return new Map(rows.map((r) => [r.orderId, r.qty]));
  }

  /**
   * SHIPPABLE ordered units per order — `SUM(order_items.quantity)` over the
   * order's lines. A line whose live product row is gone is excluded by the inner
   * join (treated as non-shippable) — errs toward NO false "partial". Pairs with
   * {@link shippedQtyByOrder}.
   */
  async shippableOrderedByOrder(orderIds: string[]): Promise<Map<string, number>> {
    if (orderIds.length === 0) return new Map();
    const rows = await db
      .select({
        orderId: order_items.order_id,
        qty: sql<number>`coalesce(sum(${order_items.quantity}), 0)::int`.mapWith(Number),
      })
      .from(order_items)
      .innerJoin(products, eq(products.id, order_items.product_id))
      .where(inArray(order_items.order_id, orderIds))
      .groupBy(order_items.order_id);
    return new Map(rows.map((r) => [r.orderId, r.qty]));
  }

  /**
   * Compact line-item summary per order for the Commandes LIST — the first
   * product's snapshot name, the line count and total units, in ONE grouped pass.
   * Uses `order_items.product_name` (the SALE-TIME snapshot, authoritative and
   * still present after a product delete) — NOT a join to `products` — so a row
   * whose product was later removed still reads its name. `firstName` is the
   * lowest-`id` line (stable order). Empty map for no ids.
   */
  async productSummaryByOrder(
    orderIds: string[],
  ): Promise<Map<string, { firstName: string; lineCount: number; totalQty: number }>> {
    if (orderIds.length === 0) return new Map();
    const rows = await db
      .select({
        orderId: order_items.order_id,
        firstName: sql<string>`(array_agg(${order_items.product_name} ORDER BY ${order_items.id}))[1]`,
        lineCount: sql<number>`count(*)::int`.mapWith(Number),
        totalQty: sql<number>`coalesce(sum(${order_items.quantity}), 0)::int`.mapWith(Number),
      })
      .from(order_items)
      .where(inArray(order_items.order_id, orderIds))
      .groupBy(order_items.order_id);
    return new Map(rows.map((r) => [r.orderId, { firstName: r.firstName, lineCount: r.lineCount, totalQty: r.totalQty }]));
  }

  async insertShipment(input: NewShipmentRow, tx: Tx): Promise<ShipmentRow> {
    const [row] = await tx.insert(shipments).values(input).returning();
    return row;
  }

  async insertShipmentItems(input: NewShipmentItemRow[], tx: Tx): Promise<ShipmentItemRow[]> {
    if (input.length === 0) return [];
    return tx.insert(shipment_items).values(input).returning();
  }

  async findShipmentById(id: string, txOrDb: DbOrTx = db): Promise<ShipmentRow | null> {
    const [row] = await txOrDb.select().from(shipments).where(eq(shipments.id, id)).limit(1);
    return row ?? null;
  }

  async listShipments(orderId: string, txOrDb: DbOrTx = db): Promise<ShipmentRow[]> {
    return txOrDb
      .select()
      .from(shipments)
      .where(eq(shipments.order_id, orderId))
      .orderBy(asc(shipments.created_at));
  }

  /** Shipment lines joined to their order line (for the BL render + the panel). */
  async listShipmentItemsWithLines(
    shipmentId: string,
    txOrDb: DbOrTx = db,
  ): Promise<Array<{ quantity: number; line: OrderItemRow }>> {
    const rows = await txOrDb
      .select({ quantity: shipment_items.quantity, line: order_items })
      .from(shipment_items)
      .innerJoin(order_items, eq(order_items.id, shipment_items.order_item_id))
      .where(eq(shipment_items.shipment_id, shipmentId));
    return rows;
  }

  /** Number of shipments raised on an order (cancel guard: block if > 0). */
  async countShipments(orderId: string, txOrDb: DbOrTx = db): Promise<number> {
    const [row] = await txOrDb
      .select({ n: count() })
      .from(shipments)
      .where(eq(shipments.order_id, orderId));
    return Number(row?.n ?? 0);
  }

  /**
   * Hard-delete a single order plus its items, status history rows and
   * refund ledger. Reserved for trusted callers — production orders are
   * append-only; the demo seed uses this to wipe its own orders. The child
   * tables have ON DELETE CASCADE FKs to orders, so the explicit child
   * deletes are belt-and-braces, not a correctness requirement.
   *
   * Returns true when an order row was removed, false when no match.
   */
  async deleteOrderById(id: string, txOrDb: DbOrTx = db): Promise<boolean> {
    return txOrDb.transaction(async (tx) => {
      await tx.delete(order_refunds).where(eq(order_refunds.order_id, id));
      await tx.delete(order_status_history).where(eq(order_status_history.order_id, id));
      await tx.delete(order_items).where(eq(order_items.order_id, id));
      const rows = await tx.delete(orders).where(eq(orders.id, id)).returning({ id: orders.id });
      return rows.length > 0;
    });
  }

  /**
   * Hard-delete EVERY order + all its dependents. Destructive — reserved for the
   * super-admin "purge + relaunch demo" flow (gated by an email-code confirm).
   * One transaction (all-or-nothing: a surprise FK rolls back rather than
   * leaving a half-purged order subsystem), children before parents. In fact
   * every order/order_item child FK is ON DELETE CASCADE (order_items, refunds,
   * status_history, returns + return_items, shipments + shipment_items,
   * promotion_redemptions), so a bare `DELETE FROM orders` would also cascade —
   * the explicit child deletes are belt-and-braces. Returns the number of order rows removed.
   */
  async deleteAllOrders(): Promise<number> {
    return db.transaction(async (tx) => {
      await tx.delete(shipment_items);
      await tx.delete(order_return_items);
      await tx.delete(shipments);
      await tx.delete(order_returns);
      await tx.delete(order_status_history);
      await tx.delete(order_refunds);
      await tx.delete(order_items);
      const res = await tx.delete(orders);
      return res.rowCount ?? 0;
    });
  }

  /**
   * All-time order KPIs in ONE round-trip / one table pass (FILTER aggregates):
   *   - `total`: every order;
   *   - `paid` + `revenueCents`: the shared REVENUE base (`revenueOrderSql` —
   *     settled via `paid_at`, NOT cancelled/refunded; `paid_at` survives both)
   *     valued NET of refunds (`netRevenueCentsSql`) — the same definition as the
   *     dashboard/analytics daily series.
   *     (`paid` used to count only `status = 'paid'`, dropping every paid order
   *     that had moved on to preparing/shipped/delivered);
   *   - `actionable`: the « À traiter » queue (`actionableOrderSql`, the SQL twin
   *     of `isActionableOrder`) — GLOBAL, so the Commandes KPI isn't limited to
   *     the loaded page and matches the dashboard.
   */
  async stats(): Promise<{ total: number; paid: number; revenueCents: number; actionable: number }> {
    // Spam-flagged orders are triaged out of every Commandes KPI so the header
    // figures match the list's « Tous » chip (and keep paid ≤ total). The revenue
    // predicate is composed inline with `flagged_spam_at IS NULL` rather than
    // baking spam into the shared `revenueOrderSql` (analytics keeps counting it).
    const notSpam = sql`orders.flagged_spam_at IS NULL`;
    const [row] = await db
      .select({
        total: sql<number>`count(*) FILTER (WHERE ${notSpam})`,
        paid: sql<number>`count(*) FILTER (WHERE ${revenueOrderSql("orders")} AND ${notSpam})`,
        revenue: sql<number>`COALESCE(SUM(${netRevenueCentsSql("orders")}) FILTER (WHERE ${revenueOrderSql("orders")} AND ${notSpam}), 0)`,
        actionable: sql<number>`count(*) FILTER (WHERE ${actionableOrderSql("orders")})`,
      })
      .from(orders);
    return {
      total: Number(row?.total ?? 0),
      paid: Number(row?.paid ?? 0),
      revenueCents: Number(row?.revenue ?? 0),
      actionable: Number(row?.actionable ?? 0),
    };
  }
}

export const orderService = new OrderService();
