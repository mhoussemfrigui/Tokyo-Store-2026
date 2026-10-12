import { boolean, index, integer, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { id, timestamps } from "@/lib/db/columns";

/**
 * product ↔ media (images).
 * Ordering + a "primary" flag for the hero image used in cards / OG tags.
 */
export const product_media = pgTable(
  "product_media",
  {
    id: id(),
    product_id: uuid("product_id").notNull(),
    media_id: uuid("media_id").notNull(),
    is_primary: boolean("is_primary").notNull().default(false),
    display_order: integer("display_order").notNull().default(0),
    alt_text: text("alt_text"),
    ...timestamps(),
  },
  (table) => ({
    pairUnique: uniqueIndex("pm_pair_unique").on(table.product_id, table.media_id),
    productIdx: index("pm_product_idx").on(table.product_id),
    mediaIdx: index("pm_media_idx").on(table.media_id),
  }),
);

export type ProductMediaRow = typeof product_media.$inferSelect;
export type NewProductMediaRow = typeof product_media.$inferInsert;
