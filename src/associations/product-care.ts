import { index, integer, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { id, timestamps } from "@/lib/db/columns";

/**
 * product ↔ care plan OVERRIDE — the per-product control edited from the product
 * form's « Tokyo Care » sub-tab.
 *
 * A product's OFFERED care plans = the plans whose `care_plan_scope_targets`
 * match it (a direct product target OR a category target covering it), PLUS the
 * `mode='include'` rows here, MINUS the `mode='exclude'` rows here. So a product
 * can force a plan ON (even with no scope target) or SUPPRESS an inherited one.
 * `override_price_cents` (nullable, MILLIMES) lets a product set a specific flat
 * care price, overriding the plan's own pricing.
 *
 * Soft links (no cross-module FK), mirroring `product_categories`; the
 * `care_plan_id` CASCADE + the `mode` CHECK live in the migration.
 */
export const product_care = pgTable(
  "product_care",
  {
    id: id(),
    product_id: uuid("product_id").notNull(),
    care_plan_id: uuid("care_plan_id").notNull(),
    /** 'include' = offer this plan on the product; 'exclude' = suppress it. CHECK in migration. */
    mode: text("mode").notNull().default("include"),
    /** Per-product flat price override in MILLIMES (NULL = use the plan's own pricing). */
    override_price_cents: integer("override_price_cents"),
    ...timestamps(),
  },
  (table) => ({
    pairUnique: uniqueIndex("prodcare_pair_unique").on(table.product_id, table.care_plan_id),
    productIdx: index("prodcare_product_idx").on(table.product_id),
    planIdx: index("prodcare_plan_idx").on(table.care_plan_id),
  }),
);

export type ProductCareRow = typeof product_care.$inferSelect;
export type NewProductCareRow = typeof product_care.$inferInsert;
export type ProductCareMode = "include" | "exclude";
