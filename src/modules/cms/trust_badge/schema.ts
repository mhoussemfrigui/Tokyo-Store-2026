import { boolean, index, integer, pgTable, text } from "drizzle-orm/pg-core";

import { id, timestamps } from "@/lib/db/columns";

/**
 * Trust badges — the admin-managed reassurance strip ("Paiement sécurisé",
 * "Retours sous conditions", …) that renders in the product buy-box and,
 * per the Catalogues/placement settings, on the cart + checkout pages. Replaces
 * the previously hardcoded badge lists so operators manage them in one place.
 *
 * `icon` is a lucide-react icon name from the curated set (TRUST_ICON_NAMES);
 * the workflow rejects anything outside it. `kind` is an optional discriminator
 * for the built-ins ('security' | 'delivery' | 'returns' | 'warranty' | NULL for
 * a free-form notice) so the renderer can special-case dynamic copy. `visibility`
 * gates when the badge shows relative to stock (store is physical-only — the
 * former `preorder` value was retired by migration 0179).
 *
 * DB-only constraints (migrations 0060 + 0179; db:generate frozen at 0007):
 *   - CHECK trust_badges_visibility_chk: visibility IN ('always','in_stock')
 *   - CHECK trust_badges_kind_chk: kind IS NULL OR kind IN (security,delivery,returns,warranty)
 *   - INDEX trust_badges_active_order_idx (is_active, display_order) — matches listActive()
 */
export const trust_badges = pgTable(
  "trust_badges",
  {
    id: id(),
    kind: text("kind"), // 'security' | 'delivery' | 'returns' | 'warranty' | NULL
    label: text("label").notNull(),
    icon: text("icon").notNull().default("ShieldCheck"),
    visibility: text("visibility").notNull().default("always"), // always | in_stock
    is_active: boolean("is_active").notNull().default(true),
    display_order: integer("display_order").notNull().default(0),
    ...timestamps(),
  },
  (table) => ({
    // One composite matching listActive (WHERE is_active ORDER BY display_order);
    // replaced the two unused single-column indexes in migration 0179.
    activeOrderIdx: index("trust_badges_active_order_idx").on(table.is_active, table.display_order),
  }),
);

export type TrustBadgeRow = typeof trust_badges.$inferSelect;
export type NewTrustBadgeRow = typeof trust_badges.$inferInsert;

/** When a badge shows relative to stock state (physical-only store; no preorder). */
export type TrustBadgeVisibility = "always" | "in_stock";
