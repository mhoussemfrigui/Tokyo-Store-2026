import {
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { id, timestamps } from "@/lib/db/columns";

/**
 * Order module.
 *
 *   orders                 — one per checkout
 *   order_items            — line items (snapshot of product at purchase time)
 *   order_status_history   — append-only status transitions for audit
 *   order_refunds          — append-only partial-refund ledger
 *
 * No JSON content. Product fields are snapshotted into columns so refunds
 * + invoices stay accurate even if the catalog changes later.
 *
 * `user_id` is a soft link to auth.users (cross-module). Anonymous orders
 * (guest checkout) store contact_email instead.
 */

export const orderStatusEnum = pgEnum("order_status", [
  "pending",
  "paid",
  "preparing",
  "shipped",
  "delivered",
  "cancelled",
  "refunded",
]);

export const paymentMethodEnum = pgEnum("payment_method", [
  "konnect",
  "flouci",
  "clictopay",     // Monétique Tunisie / SMT
  "cod",           // cash on delivery
  "card_stripe",   // forward-compat
  "cash",          // offline counter settlement (operator-created orders)
  "bank_transfer", // offline wire settlement (operator-created orders)
]);

export const deliveryMethodEnum = pgEnum("delivery_method", [
  "home_delivery",
  "drive_by_pickup",
  "in_store",
]);

/** Sales CHANNEL — where the order originated (migration 0172). Set once at
 *  placement, threaded via the workflow CONTEXT (never a client-supplied schema
 *  field, so a storefront request can't forge « erp »). No wholesale/B2B channel. */
export const orderChannelEnum = pgEnum("order_channel", [
  "storefront", // customer self-checkout on the shop
  "operator",   // staff-created « Nouvelle commande » (manual order)
  "express",    // one-tap achat express / quick-buy
  "erp",        // pushed in by an external ERP/WMS over the keyed order API
]);

export const orders = pgTable(
  "orders",
  {
    id: id(),
    order_number: text("order_number").notNull(),
    user_id: text("user_id"),
    contact_email: text("contact_email").notNull(),
    contact_phone: text("contact_phone"),

    status: orderStatusEnum("status").notNull().default("pending"),
    currency: text("currency").notNull().default("TND"),

    subtotal_cents: integer("subtotal_cents").notNull(),
    shipping_cents: integer("shipping_cents").notNull().default(0),
    /** Coupon flat-discount (all reductions). */
    discount_cents: integer("discount_cents").notNull().default(0),
    tax_cents: integer("tax_cents").notNull().default(0),
    /** Manual post-sale TVA override for the invoice (millimes). NULL = use the
     *  computed tax_cents. Set by the admin order/facture control. */
    tax_manual_cents: integer("tax_manual_cents"),
    /** Tokyo Care protection add-on charge (millimes, ex-TVA; migration 0203). Its
     *  TVA is folded into `tax_cents`. Server-recomputed at placement; the per-line
     *  breakdown lives in `order_care_items`. 0 when nothing was protected. */
    care_cents: integer("care_cents").notNull().default(0),
    total_cents: integer("total_cents").notNull(),

    /** Snapshot of the shipping address at order time (denormalised). */
    ship_full_name: text("ship_full_name").notNull(),
    ship_street_line1: text("ship_street_line1").notNull(),
    ship_street_line2: text("ship_street_line2"),
    ship_city: text("ship_city").notNull(),
    ship_region: text("ship_region"),
    ship_postal_code: text("ship_postal_code"),
    ship_country: text("ship_country").notNull().default("TN"),
    ship_phone: text("ship_phone"),

    /** Delivery method + a SNAPSHOT of the chosen agent / pickup location so a
     *  historical order survives later edits/deletes of those rows. The
     *  resolved price lives in `shipping_cents` (reused, no new money column). */
    delivery_method: deliveryMethodEnum("delivery_method").notNull().default("home_delivery"),
    delivery_agent_id: uuid("delivery_agent_id"),
    pickup_location_id: uuid("pickup_location_id"),
    delivery_agent_name: text("delivery_agent_name"),
    pickup_location_name: text("pickup_location_name"),
    pickup_location_address: text("pickup_location_address"),

    payment_method: paymentMethodEnum("payment_method"),
    payment_reference: text("payment_reference"), // gateway tx id
    paid_at: timestamp("paid_at", { withTimezone: true }),
    /** Manually-recorded amount RECEIVED (migration 0199) — powers the «
     *  Paiement manuel » control. NULL = no partial recorded (state derives from
     *  paid_at); 0<X<due = partial (paid_at stays null); = due = fully paid. */
    amount_paid_cents: integer("amount_paid_cents"),
    /** Explicit confirmation moment (migration 0101). Set automatically when an
     *  online order settles (→ paid), manually via the operator "Confirmer la
     *  commande" action for COD, and back-stopped on any forward transition.
     *  NULL = received but not yet confirmed (stepper's "Confirmée" stays unlit). */
    confirmed_at: timestamp("confirmed_at", { withTimezone: true }),

    /** Spam-triage flag (migration 0165). Set when an operator classifies the order
     *  as spam / junk (fake gateway abandons, bot orders). A flagged order is HIDDEN
     *  from the default Commandes list AND the « À traiter » queue (excluded from the
     *  actionable count + queue predicate), but stays reachable via the « Spam »
     *  filter, where it can be reviewed and cancelled. NULL = not flagged. */
    flagged_spam_at: timestamp("flagged_spam_at", { withTimezone: true }),
    flagged_spam_by_user_id: text("flagged_spam_by_user_id"),

    /** ERP linking — opaque code from an external system (ERP/WMS/3PL) for
     *  two-way sync over the keyed order API. Unique when set (migration 0055).
     *  NULL until an integration claims the order. */
    external_ref: text("external_ref"),

    /** Sales channel — the order's ORIGIN (migration 0172). Set once at placement
     *  from the workflow context (storefront default; express / operator / erp
     *  tagged by their creation path). Drives the admin « Origine / Canal » filter. */
    channel: orderChannelEnum("channel").notNull().default("storefront"),

    /** Marketing SOURCE — where a manually-created order came from (Facebook,
     *  Instagram, TikTok, phone…). Operator-supplied on « Nouvelle commande »;
     *  NULL for storefront / express / erp. Free text (shared list in
     *  lib/order/order-source.ts), distinct from `channel` (the creation PATH).
     *  Migration 0198. */
    source: text("source"),

    /**
     * Fiscal/logistics document numbers — gapless sequential codes drawn from
     * `document_sequences` and stamped ONCE when the operator issues each
     * document (idempotent). NULL = not issued yet. Each has a partial-unique
     * index (see migration 0052). The order_number stays the operational id;
     * these are the legal/printed numbers (facture, avoir, bon de livraison).
     */
    invoice_number: text("invoice_number"),
    invoiced_at: timestamp("invoiced_at", { withTimezone: true }),
    credit_note_number: text("credit_note_number"),
    credit_note_at: timestamp("credit_note_at", { withTimezone: true }),
    /** Refund total (millimes) SNAPSHOT at the moment the avoir number was drawn,
     *  so a later refund can't change the amount printed on an already-issued
     *  credit note. Null on avoirs issued before this column (renderer falls back
     *  to the live order_refunds sum). */
    credit_note_amount_cents: integer("credit_note_amount_cents"),
    delivery_note_number: text("delivery_note_number"),
    delivery_note_at: timestamp("delivery_note_at", { withTimezone: true }),

    notes: text("notes"),
    ...timestamps(),
  },
  (table) => ({
    orderNumberUnique: uniqueIndex("orders_order_number_unique").on(table.order_number),
    userIdx: index("orders_user_idx").on(table.user_id),
    createdAtIdx: index("orders_created_at_idx").on(table.created_at),
    // NOTE: `orders_status_idx` and `orders_user_created_idx` were dropped in
    // migration 0038 — each was fully covered by a sibling the planner prefers
    // (orders_status_recent_idx [status, created_at DESC] and the partial
    // orders_user_recent_idx). The status filter + account-history queries are
    // served by those baseline-raw-tail indexes.
    // NOTE: a functional index `orders_contact_email_lower_idx` on
    // lower(contact_email) also exists for the case-insensitive guest-email
    // match in userOrEmailCond. It lives only in the baseline SQL's raw tail,
    // outside the Drizzle snapshot — declaring it here too would make
    // drizzle-kit generate a duplicate CREATE INDEX.
    // NOTE: the functional index `orders_order_number_upper_idx` on
    // upper(order_number) (migration 0098) backs the case-insensitive
    // `findOrderByNumber` lookup (admin warranty/SAV search), which wraps the
    // column in upper() and so couldn't use orders_order_number_unique.
    // Migration-only for the same reason as above.
    // NOTE: `orders_updated_at_idx (updated_at)` (migration 0055) backs the
    // external order API's `?since=` incremental sync (listForApi); the partial
    // uniques `orders_external_ref_uniq` (0055) + `orders_{invoice,credit_note,
    // delivery_note}_number_uniq` (0052) are migration-only (partial uniques the
    // Drizzle builder can't express) — see the column doc-comments above.
  }),
);

export const order_items = pgTable(
  "order_items",
  {
    id: id(),
    order_id: uuid("order_id").notNull(),
    product_id: uuid("product_id").notNull(),
    /** Product snapshot — survives catalog edits. */
    product_name: text("product_name").notNull(),
    product_slug: text("product_slug").notNull(),
    product_sku: text("product_sku"),
    product_image_url: text("product_image_url"),
    /**
     * Variant snapshot — NULL for a simple product. `variant_id` is the
     * (soft-FK) id at purchase time; `variant_sku` + `variant_label` ("Rouge
     * / 512 Go") + `variant_image_url` (the per-variant photo, falls back to
     * `product_image_url` at display) are snapshotted so the order line
     * survives a later variant edit or deletion.
     */
    variant_id: text("variant_id"),
    variant_sku: text("variant_sku"),
    variant_label: text("variant_label"),
    variant_image_url: text("variant_image_url"),
    /**
     * Warranty snapshot at purchase — the resolved cascade value. Drives the
     * "under warranty / expired" check in the warranty (SAV) lookup (purchase
     * date + `warranty_months`).
     */
    warranty_months: integer("warranty_months"),
    warranty_label: text("warranty_label"),
    unit_price_cents: integer("unit_price_cents").notNull(),
    quantity: integer("quantity").notNull(),
    subtotal_cents: integer("subtotal_cents").notNull(),
    /** Per-line TVA snapshot at sale (millimes) + applied rate (bps, audit). */
    tax_cents: integer("tax_cents").notNull().default(0),
    tax_rate_bps: integer("tax_rate_bps"),
    /** Operator pick/pack stamp — set when this line is ticked "préparé" in the
     *  preparation panel. Advisory only (does not gate the "shipped" transition). */
    picked_at: timestamp("picked_at", { withTimezone: true }),
    ...timestamps(),
  },
  (table) => ({
    orderIdx: index("order_items_order_idx").on(table.order_id),
    // Declared to match the baseline raw-SQL index (getTopSellingProducts relies
    // on it) so the Drizzle schema stays the source of truth.
    productIdx: index("order_items_product_idx").on(table.product_id),
  }),
);

/**
 * Tokyo Care snapshot — one row per order LINE that carried a paid protection
 * plan (migration 0203). Snapshots the plan (name + duration) and the computed
 * money so the order survives later plan edits/deletion. `care_plan_id` is a SOFT
 * reference (no cross-module FK). `care_cents` is the line total (ex-TVA);
 * `tax_cents`/`tax_rate_bps` the per-line care TVA snapshot. The sum of
 * `care_cents` equals `orders.care_cents`; the sum of `tax_cents` is included in
 * `orders.tax_cents`.
 */
export const order_care_items = pgTable(
  "order_care_items",
  {
    id: id(),
    order_id: uuid("order_id").notNull(),
    /** The goods line this protection rides on (soft link to order_items.id). */
    order_item_id: uuid("order_item_id").notNull(),
    product_id: uuid("product_id").notNull(),
    care_plan_id: uuid("care_plan_id").notNull(),
    /** Plan snapshot at purchase. */
    plan_name: text("plan_name").notNull(),
    duration_months: integer("duration_months").notNull(),
    /** Per-unit care price (millimes); `care_cents` = unit × qty (per-unit mode)
     *  or `unit_care_cents` once (per-line mode). */
    unit_care_cents: integer("unit_care_cents").notNull(),
    quantity: integer("quantity").notNull(),
    care_cents: integer("care_cents").notNull(),
    tax_cents: integer("tax_cents").notNull().default(0),
    tax_rate_bps: integer("tax_rate_bps"),
    ...timestamps(),
  },
  (table) => ({
    orderIdx: index("order_care_items_order_idx").on(table.order_id),
    itemIdx: index("order_care_items_item_idx").on(table.order_item_id),
    planIdx: index("order_care_items_plan_idx").on(table.care_plan_id),
  }),
);

export const order_status_history = pgTable(
  "order_status_history",
  {
    id: id(),
    order_id: uuid("order_id").notNull(),
    from_status: orderStatusEnum("from_status"),
    to_status: orderStatusEnum("to_status").notNull(),
    actor_user_id: text("actor_user_id"),
    notes: text("notes"),
    ...timestamps(),
  },
  (table) => ({
    orderIdx: index("osh_order_idx").on(table.order_id),
  }),
);

/**
 * Append-only ledger of partial refunds issued against an order. Each row
 * captures one admin action — there is intentionally no "void / reverse"
 * column; reversing means logging a negative amount. The order's status
 * (e.g. "refunded") is transitioned independently via the workflow.
 */
export const order_refunds = pgTable(
  "order_refunds",
  {
    id: id(),
    order_id: uuid("order_id").notNull(),
    amount_cents: integer("amount_cents").notNull(),
    reason: text("reason"),
    created_by_user_id: text("created_by_user_id"),
    ...timestamps(),
  },
  (table) => ({
    orderIdx: index("order_refunds_order_idx").on(table.order_id),
    createdAtIdx: index("order_refunds_created_at_idx").on(table.created_at),
  }),
);

/**
 * Partial shipments (bons de livraison). One order → one or more parcels, each a
 * gapless BL number (drawn from `document_sequences` kind="delivery_note", the
 * SAME series as the legacy whole-order BL). `shipment_items` records the per-
 * line subset quantity. The shipped quantity per order line is DERIVED as
 * `SUM(shipment_items.quantity)` (single source of truth, no denormalized
 * counter to drift) and bounds both over-shipping and edit-removal of a line.
 * FKs + the per-(shipment,line) unique + the qty>0 CHECK live in migration 0056.
 */
export const shipments = pgTable(
  "shipments",
  {
    id: id(),
    order_id: uuid("order_id").notNull(),
    /** Gapless BL number, stamped once at creation. */
    delivery_note_number: text("delivery_note_number").notNull(),
    delivery_note_at: timestamp("delivery_note_at", { withTimezone: true }).notNull().defaultNow(),
    /** Per-parcel delivery snapshot (NULL = inherit the order's). */
    delivery_method: deliveryMethodEnum("delivery_method"),
    delivery_agent_name: text("delivery_agent_name"),
    tracking_ref: text("tracking_ref"),
    shipped_at: timestamp("shipped_at", { withTimezone: true }),
    created_by_user_id: text("created_by_user_id"),
    notes: text("notes"),
    ...timestamps(),
  },
  (table) => ({
    orderIdx: index("shipments_order_idx").on(table.order_id),
    blNumberUniq: uniqueIndex("shipments_delivery_note_number_uniq").on(table.delivery_note_number),
  }),
);

export const shipment_items = pgTable(
  "shipment_items",
  {
    id: id(),
    shipment_id: uuid("shipment_id").notNull(),
    order_item_id: uuid("order_item_id").notNull(),
    quantity: integer("quantity").notNull(),
    ...timestamps(),
  },
  (table) => ({
    shipmentIdx: index("shipment_items_shipment_idx").on(table.shipment_id),
    orderItemIdx: index("shipment_items_order_item_idx").on(table.order_item_id),
    shipmentItemUniq: uniqueIndex("shipment_items_shipment_order_item_uniq").on(
      table.shipment_id,
      table.order_item_id,
    ),
  }),
);

export type OrderRow = typeof orders.$inferSelect;
export type NewOrderRow = typeof orders.$inferInsert;
export type OrderItemRow = typeof order_items.$inferSelect;
export type NewOrderItemRow = typeof order_items.$inferInsert;
export type OrderCareItemRow = typeof order_care_items.$inferSelect;
export type NewOrderCareItemRow = typeof order_care_items.$inferInsert;
export type OrderStatusHistoryRow = typeof order_status_history.$inferSelect;
export type NewOrderStatusHistoryRow = typeof order_status_history.$inferInsert;
export type OrderRefundRow = typeof order_refunds.$inferSelect;
export type NewOrderRefundRow = typeof order_refunds.$inferInsert;
export type ShipmentRow = typeof shipments.$inferSelect;
export type NewShipmentRow = typeof shipments.$inferInsert;
export type ShipmentItemRow = typeof shipment_items.$inferSelect;
export type NewShipmentItemRow = typeof shipment_items.$inferInsert;
export type OrderStatus = (typeof orderStatusEnum.enumValues)[number];
export type PaymentMethod = (typeof paymentMethodEnum.enumValues)[number];
export type OrderChannel = (typeof orderChannelEnum.enumValues)[number];
