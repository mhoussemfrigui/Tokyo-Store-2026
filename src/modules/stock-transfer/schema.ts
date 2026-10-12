import { sql } from "drizzle-orm";
import { index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { id, softDelete, timestamps } from "@/lib/db/columns";

/**
 * Inter-location stock TRANSFERS — moving units between the stores + the central
 * depot the website sells from. A transfer is a request that walks a lifecycle;
 * the physical stock only MOVES on completion (source `stock_levels` −qty, dest
 * +qty, each a `transfer` ledger leg), so the authoritative product/variant
 * `stock_qty` TOTAL is unchanged by a transfer — units just relocate. Overselling
 * isn't worsened by not reserving (the sellable total is the same); a completion
 * validates the source physically has the units.
 *
 * Order-driven transfers carry `order_id` (an online sale the depot couldn't
 * fill triggers a store→depot move); standalone replenishment/rebalancing
 * transfers leave it null. `from`/`to` are soft uuid links to `stock_locations`
 * (a removed location keeps its transfer history).
 */
export const TRANSFER_STATUSES = [
  "requested", // created, awaiting the source store to accept
  "accepted", // source acknowledged; goods being prepared
  "in_transit", // dispatched from the source, not yet received
  "completed", // received at destination — stock has MOVED (ledgered)
  "cancelled", // aborted before completion — no stock moved
] as const;
export type TransferStatus = (typeof TRANSFER_STATUSES)[number];

/** A transfer past this status is terminal (no further transitions, no stock change). */
export const TRANSFER_TERMINAL: readonly TransferStatus[] = ["completed", "cancelled"];

export const TRANSFER_SOURCES = ["manual", "auto"] as const;
export type TransferSource = (typeof TRANSFER_SOURCES)[number];

export const stock_transfers = pgTable(
  "stock_transfers",
  {
    id: id(),
    /** Human display sequence (TR-<ref>) from a DB sequence — race-free. Filled
     *  by the `stock_transfer_ref_seq` default, so it's optional on insert. */
    ref: integer("ref")
      .notNull()
      .default(sql`nextval('stock_transfer_ref_seq')`),
    from_location_id: uuid("from_location_id").notNull(),
    to_location_id: uuid("to_location_id").notNull(),
    /** One of TRANSFER_STATUSES (free text + app-enforced transitions). */
    status: text("status").notNull().default("requested"),
    /** "manual" (operator) or "auto" (order-driven, requested by the system). */
    source: text("source").notNull().default("manual"),
    /** The online order that triggered this move; null = standalone transfer. */
    order_id: uuid("order_id"),
    note: text("note"),
    /** Actor who requested it (admin user id / "system" for auto). */
    requested_by: text("requested_by"),
    accepted_at: timestamp("accepted_at", { withTimezone: true }),
    dispatched_at: timestamp("dispatched_at", { withTimezone: true }),
    completed_at: timestamp("completed_at", { withTimezone: true }),
    cancelled_at: timestamp("cancelled_at", { withTimezone: true }),
    cancel_reason: text("cancel_reason"),
    ...timestamps(),
    ...softDelete(),
  },
  (t) => ({
    statusIdx: index("stock_transfers_status_idx").on(t.status, t.created_at),
    fromIdx: index("stock_transfers_from_idx").on(t.from_location_id),
    toIdx: index("stock_transfers_to_idx").on(t.to_location_id),
    // Partial: order_id is a mostly-NULL soft link (only order-driven transfers
    // carry one) and the only query filters by it — see migration 0134.
    orderIdx: index("stock_transfers_order_idx")
      .on(t.order_id)
      .where(sql`${t.order_id} is not null`),
    // Keyset for the default (unfiltered) list: created_at DESC, id DESC tiebreak,
    // partial to the query's `deleted_at IS NULL` (see 0128). Walked backward.
    listIdx: index("stock_transfers_created_at_id_idx")
      .on(t.created_at, t.id)
      .where(sql`${t.deleted_at} is null`),
    // ref is a display sequence (TR-<ref>) — UNIQUE so a manual insert can't dup it.
    refIdx: uniqueIndex("stock_transfers_ref_idx").on(t.ref),
  }),
);

export type StockTransferRow = typeof stock_transfers.$inferSelect;
export type NewStockTransferRow = typeof stock_transfers.$inferInsert;

/**
 * Line items of a transfer. `variant_id` NULL = the product-level pool (simple
 * product / shared variable), a uuid = a specific variant — the same target
 * shape `stock_levels` uses, so a completion moves the matching level rows.
 */
export const stock_transfer_items = pgTable(
  "stock_transfer_items",
  {
    id: id(),
    transfer_id: uuid("transfer_id").notNull(),
    product_id: uuid("product_id").notNull(),
    variant_id: uuid("variant_id"),
    qty: integer("qty").notNull(),
    ...timestamps(),
  },
  (t) => ({
    // Items are only ever read by transfer_id (or JOINed on products.id); the old
    // single-column product_id index was dead and dropped in 0128.
    transferIdx: index("stock_transfer_items_transfer_idx").on(t.transfer_id),
  }),
);

export type StockTransferItemRow = typeof stock_transfer_items.$inferSelect;
export type NewStockTransferItemRow = typeof stock_transfer_items.$inferInsert;
