import { index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { id } from "@/lib/db/columns";

/**
 * Append-only stock-movement ledger. ONE row per stock change, written in the
 * SAME transaction as the mutation, so the NET change since a baseline is
 * reconstructable + ERP-reconcilable ("system says 47, ERP says 50") — opening
 * balances are not ledgered.
 *
 * `delta` is the signed change (-2 sold, +3 received); `resulting_qty` is the
 * on-hand AFTER the change when known (null for untracked lines). `reason`
 * classifies the source. `variant_id` is a soft link (text, like order_items)
 * so it survives variant deletion; null = the product-level pool.
 *
 * Never updated or deleted — corrections are new rows.
 */
// Module-private: only the StockMovementReason type derives from it (no value
// consumer outside this file). Exported as the TYPE below.
const stockMovementReasons = [
  "order", // sale: order placement decrement
  "cancellation", // order cancelled → restock
  "refund", // full refund of an UNSHIPPED order → restock (goods never left)
  "return", // approved+received return → restock
  "api_delta", // external add/remove (atomic ±N)
  "api_set", // external absolute set
  "admin", // admin stock edit (bulk / editor)
  "transfer", // inter-location transfer leg (−N at source, +N at destination; total unchanged)
] as const;
export type StockMovementReason = (typeof stockMovementReasons)[number];

export const stock_movements = pgTable(
  "stock_movements",
  {
    id: id(),
    product_id: uuid("product_id").notNull(),
    /** Soft link (survives variant deletion); null = product-level pool. */
    variant_id: text("variant_id"),
    /** Signed change. Negative = removed/sold, positive = added/restocked. */
    delta: integer("delta").notNull(),
    /** On-hand after the change; null when the line is untracked. */
    resulting_qty: integer("resulting_qty"),
    reason: text("reason").notNull(),
    /** Originating order, when the movement came from the order lifecycle. */
    order_id: uuid("order_id"),
    /** Stock location the change happened at (multi-location); null = legacy /
     *  single-pool movement. Soft (no FK) so a removed location keeps history. */
    location_id: uuid("location_id"),
    /** Admin / API-key owner who caused it (null = system/anonymous). */
    actor_user_id: text("actor_user_id"),
    /** Optional free-text note (e.g. ERP movement type, "damaged"). */
    note: text("note"),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    productIdx: index("stock_movements_product_idx").on(table.product_id, table.created_at),
    orderIdx: index("stock_movements_order_idx").on(table.order_id),
    // Serves the unfiltered ERP incremental-sync keyset (ORDER BY created_at, id
    // with no product filter) — see migration 0120.
    createdAtIdIdx: index("stock_movements_created_at_id_idx").on(table.created_at, table.id),
  }),
);

export type StockMovementRow = typeof stock_movements.$inferSelect;

