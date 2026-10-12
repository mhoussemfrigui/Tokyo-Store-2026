import { boolean, index, integer, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

import { id, softDelete, timestamps } from "@/lib/db/columns";

/**
 * FAQ module.
 *
 * Two targeting models coexist on this table:
 *   - `scope = 'help'` (default) → the global help center. Optional
 *     `faq_category_id` groups them by topic on /help.
 *   - `product_id` populated → FAQ scoped to a specific product page.
 *   - `category_id` populated → FAQ scoped to a specific category page.
 *   - `brand_id` populated → FAQ scoped to a specific brand page.
 *
 * Invariant (DB CHECK `faqs_scope_target_chk`, widened in 0018 for `brand_id`,
 * via `num_nonnulls`): at most one of `product_id` / `category_id` / `brand_id`
 * is non-null. When all are NULL the row is help-scoped. Soft FK only — matches
 * how `faq_category_id` already works.
 *
 * The legacy `scope` text column is retained for backward compatibility:
 * existing rows seeded with `scope = 'help'` still appear on the help page. New
 * product/category/brand FAQs leave `scope` at its default and populate the
 * matching target column instead (brand FAQs migrated off the old
 * `scope = 'brand:<slug>'` string to `brand_id` in 0018 — rename-safe).
 */

export const faq_categories = pgTable(
  "faq_categories",
  {
    id: id(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    display_order: integer("display_order").notNull().default(0),
    ...timestamps(),
  },
  (table) => ({
    slugUnique: uniqueIndex("faq_categories_slug_unique").on(table.slug),
  }),
);

export const faqs = pgTable(
  "faqs",
  {
    id: id(),
    // Soft FK columns (uuid, deliberately no REFERENCES constraint) so a
    // cross-module delete can't cascade FAQ rows unexpectedly.
    faq_category_id: uuid("faq_category_id"),
    /** Soft FK to products.id — populated for product-scoped FAQs only. */
    product_id: uuid("product_id"),
    /** Soft FK to categories.id — populated for category-scoped FAQs only. */
    category_id: uuid("category_id"),
    /** Soft FK to brands.id — populated for brand-scoped FAQs only. */
    brand_id: uuid("brand_id"),
    question: text("question").notNull(),
    answer: text("answer").notNull(),
    display_order: integer("display_order").notNull().default(0),
    scope: text("scope").notNull().default("help"), // legacy: "help" | "brand:<slug>" (pre-0018) | …
    is_published: boolean("is_published").notNull().default(true),
    ...timestamps(),
    ...softDelete(),
  },
  (table) => ({
    scopeIdx: index("faqs_scope_idx").on(table.scope),
    catIdx: index("faqs_cat_idx").on(table.faq_category_id),
    orderIdx: index("faqs_order_idx").on(table.display_order),
    productIdx: index("faqs_product_idx")
      .on(table.product_id)
      .where(sql`${table.product_id} is not null`),
    categoryIdx: index("faqs_category_idx")
      .on(table.category_id)
      .where(sql`${table.category_id} is not null`),
    brandIdx: index("faqs_brand_idx")
      .on(table.brand_id)
      .where(sql`${table.brand_id} is not null`),
  }),
);

export type FaqCategoryRow = typeof faq_categories.$inferSelect;
export type NewFaqCategoryRow = typeof faq_categories.$inferInsert;
export type FaqRow = typeof faqs.$inferSelect;
export type NewFaqRow = typeof faqs.$inferInsert;
