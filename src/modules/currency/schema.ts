import { sql } from "drizzle-orm";
import { boolean, integer, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";

import { id, timestamps } from "@/lib/db/columns";

/**
 * Currency registry (Commandes → Devises). A SINGLE global active currency drives
 * how prices are LABELLED across the storefront, JSON-LD, and new-order snapshots
 * — it does NOT convert stored amounts (money stays integer minor units of the
 * base; switching relabels going forward, the owner re-prices). Add more rows to
 * make other currencies available to switch to later.
 *
 * Exactly one row may have `is_active = true` (partial unique index, migration
 * 0078). `code` is ISO 4217 (e.g. TND). `symbol`/`symbol_position` drive display;
 * `decimals` is metadata (display precision stays governed by the `price.decimals`
 * setting today — see src/lib/currency/active.ts).
 */
export const CURRENCY_SYMBOL_POSITIONS = ["before", "after"] as const;
export type CurrencySymbolPosition = (typeof CURRENCY_SYMBOL_POSITIONS)[number];

export const currencies = pgTable(
  "currencies",
  {
    id: id(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    symbol: text("symbol").notNull(),
    symbol_position: text("symbol_position")
      .$type<CurrencySymbolPosition>()
      .notNull()
      .default("after"),
    decimals: integer("decimals").notNull().default(3),
    is_active: boolean("is_active").notNull().default(false),
    display_order: integer("display_order").notNull().default(0),
    ...timestamps(),
  },
  (t) => ({
    codeUnique: uniqueIndex("currencies_code_unique").on(t.code),
    // AT MOST one active currency: a partial unique index over the boolean,
    // indexing only the `true` rows (created in migration 0078; declared here
    // for schema parity).
    oneActive: uniqueIndex("currencies_one_active_idx")
      .on(t.is_active)
      .where(sql`${t.is_active}`),
  }),
);

export type CurrencyRow = typeof currencies.$inferSelect;
