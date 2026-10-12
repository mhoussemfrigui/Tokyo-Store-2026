import { integer, pgTable, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { id, timestamps } from "@/lib/db/columns";

/**
 * Per-filter tax override. A TVA rate keyed on an attribute VALUE (e.g. a
 * "Matière = Or" filter value) — the FILTER tier of the tax cascade:
 * product override → tax_rules(filter) → brand → category(→parent) → global.
 * `rate_bps` is basis points (1900 = 19%). FK ON DELETE CASCADE to the value.
 */
export const tax_rules = pgTable(
  "tax_rules",
  {
    id: id(),
    attribute_value_id: uuid("attribute_value_id").notNull(),
    rate_bps: integer("rate_bps").notNull(),
    ...timestamps(),
  },
  (table) => ({
    attributeValueUq: uniqueIndex("tax_rules_attribute_value_uq").on(
      table.attribute_value_id,
    ),
  }),
);

export type TaxRuleRow = typeof tax_rules.$inferSelect;
export type NewTaxRuleRow = typeof tax_rules.$inferInsert;
