import { index, integer, pgTable, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { id, timestamps } from "@/lib/db/columns";

/**
 * product ↔ product — the CURATED "Vous aimerez aussi" list (cross-sell).
 * Only used when a product's `related_mode` is `manual` or `ai`; the other
 * modes derive the rail at render time and ignore these rows. `display_order`
 * is the position in the rail (array index at save time). Both columns are
 * bare uuid soft-FKs here; ON DELETE CASCADE FKs to products(id) are added in
 * the SQL migration (matching the codebase convention).
 */
export const product_related = pgTable(
  "product_related",
  {
    id: id(),
    product_id: uuid("product_id").notNull(),
    related_product_id: uuid("related_product_id").notNull(),
    display_order: integer("display_order").notNull().default(0),
    ...timestamps(),
  },
  (table) => ({
    pairUnique: uniqueIndex("pr_pair_unique").on(table.product_id, table.related_product_id),
    productIdx: index("pr_product_idx").on(table.product_id),
    relatedIdx: index("pr_related_idx").on(table.related_product_id),
  }),
);

export type ProductRelatedRow = typeof product_related.$inferSelect;
export type NewProductRelatedRow = typeof product_related.$inferInsert;
