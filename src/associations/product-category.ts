import { boolean, index, pgTable, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { id, timestamps } from "@/lib/db/columns";

/**
 * product ↔ category — many-to-many.
 * A product can live in multiple categories (e.g. "Rolex > Montres"
 * and the leaf "Rolex > Submariner"). One of them can be marked primary
 * for breadcrumbs / canonical URL.
 */
export const product_categories = pgTable(
  "product_categories",
  {
    id: id(),
    product_id: uuid("product_id").notNull(),
    category_id: uuid("category_id").notNull(),
    is_primary: boolean("is_primary").notNull().default(false),
    ...timestamps(),
  },
  (table) => ({
    productCategoryUnique: uniqueIndex("pc_pair_unique").on(
      table.product_id,
      table.category_id,
    ),
    productIdx: index("pc_product_idx").on(table.product_id),
    categoryIdx: index("pc_category_idx").on(table.category_id),
  }),
);

export type ProductCategoryRow = typeof product_categories.$inferSelect;
export type NewProductCategoryRow = typeof product_categories.$inferInsert;
