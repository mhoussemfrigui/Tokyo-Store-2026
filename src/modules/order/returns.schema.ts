import { boolean, index, integer, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { id, timestamps } from "@/lib/db/columns";

/**
 * Customer returns (retours / RMA). A return is raised against a delivered/
 * shipped order, lists the specific lines + quantities coming back, and — when
 * RECEIVED — restocks the resellable ones. Money (refund) stays decoupled in
 * order_refunds; a return records the PHYSICAL goods movement only.
 *
 *   pending  → received (restock restockable lines) | rejected (no restock)
 *
 * Idempotency is keyed on the return LINE (order_return_items.restocked_at), not
 * the return status — so one order can have several partial returns and a
 * re-processed return never double-restocks.
 */
export const orderReturnStatusEnum = pgEnum("order_return_status", ["pending", "received", "rejected"]);

/**
 * Structured return-reason taxonomy (stored on `order_returns.reason_code`). It
 * lives in the pure `./returns-reasons` module so client components can import
 * it without pulling drizzle + these table definitions into the browser bundle;
 * re-exported here for the existing server-side consumers.
 */
export {
  RETURN_REASON_CODES,
  RETURN_REASON_LABELS,
  type ReturnReasonCode,
  ORDER_RETURN_KINDS,
  ORDER_RETURN_KIND_LABELS,
  type OrderReturnKind,
  SHIPMENT_RETURN_REASON_CODES,
  SHIPMENT_RETURN_REASON_LABELS,
  type ShipmentReturnReasonCode,
  shipmentReturnReasonLabel,
} from "./returns-reasons";

export const order_returns = pgTable(
  "order_returns",
  {
    id: id(),
    order_id: uuid("order_id").notNull(),
    /**
     * Which Retours flow this record belongs to (migration 0200; text + a CHECK
     * in the migration, mirroring the other string discriminators here):
     *   - `after_sale` (default): classic SAV/RMA — goods reached the customer.
     *   - `shipment`: « Retour d'expédition » — a shipped parcel that bounced
     *     back (customer unreachable / refused). Receiving it restocks AND
     *     cancels the order. See ORDER_RETURN_KINDS.
     */
    kind: text("kind").notNull().default("after_sale"),
    status: orderReturnStatusEnum("status").notNull().default("pending"),
    /** Structured motive (RETURN_REASON_CODES for after_sale,
     *  SHIPMENT_RETURN_REASON_CODES for shipment) for stats grouping. */
    reason_code: text("reason_code"),
    /** Free-text customer-stated motive. */
    reason: text("reason"),
    /** Operator's internal note (distinct from the customer reason). */
    comment: text("comment"),
    /** « Retour d'expédition » only — the external carrier / livreur that failed
     *  the delivery (free text snapshot; no carrier registry yet). NULL otherwise. */
    carrier_name: text("carrier_name"),
    /** « Retour d'expédition » only — the carrier's tracking reference. NULL otherwise. */
    tracking_ref: text("tracking_ref"),
    /** « Retour d'expédition » only — number of failed delivery attempts. NULL otherwise. */
    delivery_attempts: integer("delivery_attempts"),
    created_by_user_id: text("created_by_user_id"),
    processed_by_user_id: text("processed_by_user_id"),
    processed_at: timestamp("processed_at", { withTimezone: true }),
    ...timestamps(),
  },
  (table) => ({
    orderIdx: index("order_returns_order_idx").on(table.order_id),
    // Backs the per-kind Retours dashboards (« après vente » vs « expédition »):
    // each page filters `kind` then orders by created_at desc (migration 0200).
    kindCreatedIdx: index("order_returns_kind_created_idx").on(table.kind, table.created_at.desc()),
    // DB-ONLY (migration 0050): created_at + reason_code indexes back the Retours
    // dashboard's time-window + by-reason aggregation (not declared here).
  }),
);

export const order_return_items = pgTable(
  "order_return_items",
  {
    id: id(),
    return_id: uuid("return_id").notNull(),
    /** The order line being returned (links quantity back to what was sold). */
    order_item_id: uuid("order_item_id").notNull(),
    product_id: uuid("product_id").notNull(),
    /** Variant soft-link (null = simple / product-level). */
    variant_id: text("variant_id"),
    quantity: integer("quantity").notNull(),
    /** Resellable → restock on receive; false (damaged) → never restocks. */
    restockable: boolean("restockable").notNull().default(true),
    /** Per-line condition / note (e.g. "écran rayé"). For SAV study. */
    condition_note: text("condition_note"),
    /** Set ONCE when this line restocks — the idempotency anchor. */
    restocked_at: timestamp("restocked_at", { withTimezone: true }),
    ...timestamps(),
  },
  (table) => ({
    returnIdx: index("order_return_items_return_idx").on(table.return_id),
    orderItemIdx: index("order_return_items_order_item_idx").on(table.order_item_id),
  }),
);

export type OrderReturnRow = typeof order_returns.$inferSelect;
export type NewOrderReturnRow = typeof order_returns.$inferInsert;
export type OrderReturnItemRow = typeof order_return_items.$inferSelect;
export type NewOrderReturnItemRow = typeof order_return_items.$inferInsert;
export type OrderReturnStatus = (typeof orderReturnStatusEnum.enumValues)[number];
