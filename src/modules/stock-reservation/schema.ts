import { sql } from "drizzle-orm";
import { index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { id, timestamps } from "@/lib/db/columns";

/**
 * Stock reservations — OPEN holds against stock, used by the précommande
 * (preorder) flow. A preorder line RESERVES units instead of decrementing: one
 * row per reserved order line, summed into `products.reserved_qty` /
 * `product_variants.reserved_qty` (so `available = stock_qty − reserved_qty`).
 * `state` drives the lifecycle:
 *   open     — live hold (counts toward reserved_qty)
 *   consumed — converted to a real stock decrement at release / conversion
 *   released — cancelled/refunded before conversion (nothing was decremented, so
 *              NO restock; the hold simply drops out of reserved_qty)
 *
 * Order-scoped (`order_id` / `order_item_id`). FKs live in the migration SQL
 * (ON DELETE CASCADE), per the repo convention — `schema.ts` does not use
 * `.references()`.
 */
export const stock_reservations = pgTable(
  "stock_reservations",
  {
    id: id(),
    order_id: uuid("order_id").notNull(),
    /** The reserved order line (NULL only for a legacy/aggregate hold). */
    order_item_id: uuid("order_item_id"),
    product_id: uuid("product_id").notNull(),
    /** NULL for a simple product or a shared-stock pool reservation. */
    variant_id: uuid("variant_id"),
    qty: integer("qty").notNull(),
    /** open | consumed | released (CHECK lives in the migration). */
    state: text("state").notNull().default("open"),
    note: text("note"),
    actor_user_id: text("actor_user_id"),
    released_at: timestamp("released_at", { withTimezone: true }),
    ...timestamps(),
  },
  (table) => ({
    // Resolve an order's holds to release / consume them.
    orderIdx: index("stock_reservations_order_idx").on(table.order_id),
    // Open holds per product/variant — backs the `reserved_qty` re-derivation.
    // Partial over the LIVE holds only, so it stays tiny.
    openProductIdx: index("stock_reservations_open_product_idx")
      .on(table.product_id, table.variant_id)
      .where(sql`${table.state} = 'open'`),
  }),
);

export type StockReservationRow = typeof stock_reservations.$inferSelect;
export type NewStockReservationRow = typeof stock_reservations.$inferInsert;
