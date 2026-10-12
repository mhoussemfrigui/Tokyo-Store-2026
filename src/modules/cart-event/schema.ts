import { index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { id } from "@/lib/db/columns";

/**
 * Add-to-cart event log (GA4-style). One append-only row per add-to-cart, used
 * for "produits les plus ajoutés au panier" analytics — segmented by who added
 * it (an authenticated `client` vs a guest `visitor`) over a time window.
 *
 * Distinct from `cart_items` (the live cart state): a removed item still leaves
 * its add event here, so the metric counts INTENT, not current basket contents.
 * Unbounded + retention-purged (see RETENTION_WINDOWS.cart_events).
 */
export const cart_events = pgTable(
  "cart_events",
  {
    id: id(),
    product_id: uuid("product_id").notNull(),
    /** Variant soft-link; "" for a simple product (mirrors cart_items). */
    variant_id: text("variant_id").notNull().default(""),
    quantity: integer("quantity").notNull().default(1),
    /** 'client' = authenticated at add time · 'visitor' = guest token. */
    actor_kind: text("actor_kind").notNull(),
    /** 'cart' = PDP / listing add · 'quick_add' = 1-tap listing add. */
    source: text("source").notNull().default("cart"),
    occurred_at: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    occurredIdx: index("cart_events_occurred_idx").on(table.occurred_at),
    productOccurredIdx: index("cart_events_product_occurred_idx").on(table.product_id, table.occurred_at),
  }),
);

export type CartEventRow = typeof cart_events.$inferSelect;
export type NewCartEventRow = typeof cart_events.$inferInsert;

/** Who added the item, at add time. */
export type CartActorKind = "client" | "visitor";
