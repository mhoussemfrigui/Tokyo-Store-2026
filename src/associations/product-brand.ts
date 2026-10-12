import { index, pgTable, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { id, timestamps } from "@/lib/db/columns";

/**
 * product ↔ brand. Modelled 1:1 (a product has at most one brand) but
 * stored as a join table for total module independence and easier swap
 * if multi-brand collaborations come later.
 */
export const product_brands = pgTable(
  "product_brands",
  {
    id: id(),
    product_id: uuid("product_id").notNull(),
    brand_id: uuid("brand_id").notNull(),
    ...timestamps(),
  },
  (table) => ({
    productUnique: uniqueIndex("pb_product_unique").on(table.product_id),
    brandIdx: index("pb_brand_idx").on(table.brand_id),
  }),
);

export type ProductBrandRow = typeof product_brands.$inferSelect;
export type NewProductBrandRow = typeof product_brands.$inferInsert;
