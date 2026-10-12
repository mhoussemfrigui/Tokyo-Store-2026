import { boolean, index, integer, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

import { id, softDelete, timestamps } from "@/lib/db/columns";

/**
 * Stock LOCATIONS — physical stores / depots a business holds inventory at.
 *
 * Multi-location is OPT-IN: a single seeded default "Main" location holds all
 * stock until the operator enables per-location mode (setting
 * `inventory.location_mode`). The denormalised totals on
 * `products.stock_qty` / `product_variants.stock_qty` remain the authoritative
 * sellable count; per-location detail lives in `stock_levels` below.
 *
 * `carrier_ref` is an OPTIONAL soft link to a delivery pickup-point / carrier
 * (gated by `inventory.carrier_link_enabled`) so a pickup/in-store order can
 * later be attributed to the right location. Kept as text (not an FK) so it
 * survives the linked record being removed.
 */
export const stock_locations = pgTable(
  "stock_locations",
  {
    id: id(),
    name: text("name").notNull(),
    /** Optional short code / ERP id for the location. */
    code: text("code"),
    /** Optional soft link to a delivery pickup_location / carrier id. */
    carrier_ref: text("carrier_ref"),
    /** Exactly one location is the default (the implicit fulfilment store). */
    is_default: boolean("is_default").notNull().default(false),
    is_active: boolean("is_active").notNull().default(true),
    display_order: integer("display_order").notNull().default(0),
    ...timestamps(),
    ...softDelete(),
  },
  (t) => ({
    // At most ONE default location store-wide (mirrors product_variants_one_default).
    oneDefault: uniqueIndex("stock_locations_one_default")
      .on(t.is_default)
      .where(sql`${t.is_default} and ${t.deleted_at} is null`),
    codeUnique: uniqueIndex("stock_locations_code_unique")
      .on(t.code)
      .where(sql`${t.code} is not null and ${t.deleted_at} is null`),
    orderIdx: index("stock_locations_display_order_idx").on(t.display_order),
  }),
);

export type StockLocationRow = typeof stock_locations.$inferSelect;
export type NewStockLocationRow = typeof stock_locations.$inferInsert;

/**
 * Per-location stock DETAIL — one row per (location, product|variant). The
 * source of truth for per-location quantities; the product/variant `stock_qty`
 * columns are the cached SUM across active locations (maintained in the same
 * tx as any write).
 *
 * `variant_id` NULL = the product-level pool (simple product, or a variable
 * product's shared pool). A non-null `variant_id` is a per-variant level.
 * `qty` is non-negative (CHECK in the migration, mirroring stock_qty_nonneg).
 */
export const stock_levels = pgTable(
  "stock_levels",
  {
    id: id(),
    location_id: uuid("location_id").notNull(),
    product_id: uuid("product_id").notNull(),
    /** Null = product-level pool; a uuid = per-variant level. */
    variant_id: uuid("variant_id"),
    qty: integer("qty").notNull().default(0),
    ...timestamps(),
  },
  (t) => ({
    // Two partial uniques: NULL variant_id is "distinct" under a plain UNIQUE,
    // so split the product-pool row from the per-variant rows.
    productPoolUnique: uniqueIndex("stock_levels_product_pool_unique")
      .on(t.location_id, t.product_id)
      .where(sql`${t.variant_id} is null`),
    variantUnique: uniqueIndex("stock_levels_variant_unique")
      .on(t.location_id, t.variant_id)
      .where(sql`${t.variant_id} is not null`),
    productIdx: index("stock_levels_product_idx").on(t.product_id),
    variantIdx: index("stock_levels_variant_idx")
      .on(t.variant_id)
      .where(sql`${t.variant_id} is not null`),
    locationIdx: index("stock_levels_location_idx").on(t.location_id),
  }),
);

export type StockLevelRow = typeof stock_levels.$inferSelect;
export type NewStockLevelRow = typeof stock_levels.$inferInsert;
