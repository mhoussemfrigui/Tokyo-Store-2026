import { index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

import { id } from "@/lib/db/columns";

/**
 * Manual product pins for the showcase collection pages (Nouveautés, Top
 * ventes, Promotions). Pinned products render FIRST, in
 * `position` order, ahead of the auto-selected (rules-based) products.
 *
 * `product_id` is uuid with a real CASCADE FK to products.id (baseline), so
 * hard-deleting a product sweeps its pins. A stale pin (product soft-deleted
 * or unpublished) is still harmless — the loader filters to published
 * products before rendering.
 */
export const showcase_pins = pgTable(
  "showcase_pins",
  {
    id: id(),
    /** Collection slug: nouveautes | top-ventes | promotions. */
    slug: text("slug").notNull(),
    product_id: uuid("product_id").notNull(),
    position: integer("position").notNull().default(0),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`),
  },
  (t) => ({
    slugPositionIdx: index("showcase_pins_slug_position_idx").on(t.slug, t.position),
    slugProductUniq: uniqueIndex("showcase_pins_slug_product_uniq").on(t.slug, t.product_id),
  }),
);

export type ShowcasePinRow = typeof showcase_pins.$inferSelect;
export type NewShowcasePinRow = typeof showcase_pins.$inferInsert;
