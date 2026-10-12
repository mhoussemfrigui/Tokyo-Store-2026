import { index, integer, pgTable, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { id, timestamps } from "@/lib/db/columns";

/**
 * product ↔ product — the CURATED "Accessoires supplémentaires" list. A second,
 * manual-only cross-sell relation (separate from `product_related`): the PDP
 * shows a row of small accessory cards a customer can add to complete their
 * purchase. There is no derived/AI mode — the section only appears when the
 * admin has hand-picked accessories, so the table is the single source of truth.
 * `display_order` is the position in the row (array index at save time). Both
 * columns are bare uuid soft-FKs here; ON DELETE CASCADE FKs to products(id) are
 * added in the SQL migration (matching the codebase convention).
 */
export const product_complementary = pgTable(
  "product_complementary",
  {
    id: id(),
    product_id: uuid("product_id").notNull(),
    complementary_product_id: uuid("complementary_product_id").notNull(),
    display_order: integer("display_order").notNull().default(0),
    ...timestamps(),
  },
  (table) => ({
    // NB: prefix is `pcomp_`, NOT `pc_` — the `pc_` namespace is already taken by
    // product_categories (pc_pair_unique / pc_product_idx). Postgres index names
    // are schema-global, so a `pc_*` name here would silently no-op under
    // CREATE INDEX IF NOT EXISTS and the index would never be created.
    pairUnique: uniqueIndex("pcomp_pair_unique").on(
      table.product_id,
      table.complementary_product_id,
    ),
    productIdx: index("pcomp_product_idx").on(table.product_id),
    complementaryIdx: index("pcomp_complement_idx").on(table.complementary_product_id),
  }),
);

export type ProductComplementaryRow = typeof product_complementary.$inferSelect;
export type NewProductComplementaryRow = typeof product_complementary.$inferInsert;
