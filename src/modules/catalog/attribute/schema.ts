import {
  boolean,
  index,
  integer,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

import { id, softDelete, timestamps } from "@/lib/db/columns";

/**
 * Product attributes module — PrestaShop / WooCommerce-style filters.
 *
 *   product_attributes              — global filter dimensions (Matière, Mouvement…)
 *     ↓
 *   product_attribute_values        — possible values per attribute
 *     ↓
 *   product_attribute_assignments   — M2M, which products carry which value
 *
 *   category_attribute_filters      — M2M, which attributes appear as
 *                                     filters on which category
 *
 * `kind` drives BOTH the admin value editor and the storefront filter rendering:
 *   - `select`      — single-choice list (storefront: single-choice filter)
 *   - `multiselect` — multi-choice list (storefront: checkboxes)
 *   - `color`       — multi-choice list, each value carries a `color_hex`
 *                     (storefront: colour swatches)
 *   - `boolean`     — a single auto-seeded value; assigned-or-not (one toggle)
 *   - `number`      — a per-product NUMBER (no value list) → product_attribute_scalars
 *                     (storefront: min–max range filter)
 *   - `text`        — a per-product free TEXT (no value list) → product_attribute_scalars
 *                     (informational; shown on the PDP, not a filter)
 *
 * select/multiselect/color/boolean live in the value-list M2M
 * (product_attribute_values + product_attribute_assignments); number/text are
 * per-(product, attribute) scalars in product_attribute_scalars.
 */
export const attributeKindEnum = pgEnum("attribute_kind", [
  "select",
  "multiselect",
  "color",
  "boolean",
  "number",
  "text",
]);

/** Kinds whose data is a value-list M2M (product_attribute_assignments). */
export const VALUE_LIST_ATTRIBUTE_KINDS = ["select", "multiselect", "color", "boolean"] as const;

export const product_attributes = pgTable(
  "product_attributes",
  {
    id: id(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    kind: attributeKindEnum("kind").notNull().default("multiselect"),
    display_order: integer("display_order").notNull().default(0),
    is_active: boolean("is_active").notNull().default(true),
    ...timestamps(),
    ...softDelete(),
  },
  (table) => ({
    // Partial: tombstoned (soft-deleted) attributes free their slug for reuse.
    slugUnique: uniqueIndex("product_attributes_slug_unique")
      .on(table.slug)
      .where(sql`${table.deleted_at} is null`),
    displayOrderIdx: index("product_attributes_display_order_idx").on(table.display_order),
    // Backs listActiveAttributes — was migration-only (baseline 0000); declared
    // here so a schema regen can't drop it.
    activeIdx: index("product_attributes_active_idx")
      .on(table.is_active)
      .where(sql`${table.deleted_at} is null`),
  }),
);

export const product_attribute_values = pgTable(
  "product_attribute_values",
  {
    id: id(),
    attribute_id: uuid("attribute_id").notNull(),
    slug: text("slug").notNull(),
    label: text("label").notNull(),
    display_order: integer("display_order").notNull().default(0),
    /** Hex colour (e.g. "#1d4ed8") for kind="color" values; null for other kinds. */
    color_hex: text("color_hex"),
    ...timestamps(),
  },
  (table) => ({
    attributeOrderIdx: index("product_attribute_values_attribute_order_idx").on(
      table.attribute_id,
      table.display_order,
    ),
    attributeSlugUnique: uniqueIndex("product_attribute_values_attribute_slug_unique").on(
      table.attribute_id,
      table.slug,
    ),
  }),
);

/**
 * M2M between products and attribute values. Composite PK guarantees a
 * product carries each value at most once.
 */
export const product_attribute_assignments = pgTable(
  "product_attribute_assignments",
  {
    product_id: uuid("product_id").notNull(),
    attribute_value_id: uuid("attribute_value_id").notNull(),
    created_at: timestamps().created_at,
  },
  (table) => ({
    pk: primaryKey({ columns: [table.product_id, table.attribute_value_id] }),
    // (product_attribute_assignments_product_idx (product_id) dropped in 0126 —
    //  a leading-column prefix of the PK (product_id, attribute_value_id), which
    //  already serves every product-scoped read + the product_id FK cascade.)
    valueIdx: index("product_attribute_assignments_value_idx").on(table.attribute_value_id),
  }),
);

/**
 * M2M between categories and attributes — opts an attribute into the
 * filter UI on a given category. Composite PK on (category_id, attribute_id).
 */
export const category_attribute_filters = pgTable(
  "category_attribute_filters",
  {
    category_id: uuid("category_id").notNull(),
    attribute_id: uuid("attribute_id").notNull(),
    display_order: integer("display_order").notNull().default(0),
    created_at: timestamps().created_at,
  },
  (table) => ({
    pk: primaryKey({ columns: [table.category_id, table.attribute_id] }),
    // (category_attribute_filters_category_idx (category_id) dropped in 0126 —
    //  a leading-column prefix of the PK (category_id, attribute_id), which already
    //  serves the "filters on this category" reads + the category_id FK cascade.)
    // Backs the attribute_id FK + the reverse (attribute → categories) lookup;
    // was migration-only (baseline 0000) — declared here so a regen keeps it.
    attributeIdx: index("category_attribute_filters_attribute_idx").on(table.attribute_id),
  }),
);

/**
 * Per-(product, attribute) SCALAR value for `number` / `text` kinds (which don't
 * fit the predefined value-list M2M). `numeric_value` powers the storefront
 * range filter; `text_value` is shown on the PDP. Exactly one row per
 * (product, attribute). FKs ON DELETE CASCADE (added in the SQL migration).
 */
export const product_attribute_scalars = pgTable(
  "product_attribute_scalars",
  {
    id: id(),
    product_id: uuid("product_id").notNull(),
    attribute_id: uuid("attribute_id").notNull(),
    numeric_value: numeric("numeric_value"),
    text_value: text("text_value"),
    ...timestamps(),
  },
  (table) => ({
    productAttrUnique: uniqueIndex("product_attribute_scalars_product_attr_unique").on(
      table.product_id,
      table.attribute_id,
    ),
    attributeIdx: index("product_attribute_scalars_attribute_idx").on(table.attribute_id),
  }),
);

export type AttributeRow = typeof product_attributes.$inferSelect;
export type NewAttributeRow = typeof product_attributes.$inferInsert;
export type AttributeKind = (typeof attributeKindEnum.enumValues)[number];

export type AttributeValueRow = typeof product_attribute_values.$inferSelect;
export type NewAttributeValueRow = typeof product_attribute_values.$inferInsert;

export type AttributeAssignmentRow = typeof product_attribute_assignments.$inferSelect;
export type NewAttributeAssignmentRow = typeof product_attribute_assignments.$inferInsert;

export type CategoryAttributeFilterRow = typeof category_attribute_filters.$inferSelect;
export type NewCategoryAttributeFilterRow = typeof category_attribute_filters.$inferInsert;

export type AttributeScalarRow = typeof product_attribute_scalars.$inferSelect;
export type NewAttributeScalarRow = typeof product_attribute_scalars.$inferInsert;
