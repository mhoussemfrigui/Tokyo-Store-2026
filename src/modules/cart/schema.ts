import { index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

import { id, timestamps } from "@/lib/db/columns";

/**
 * Carts module.
 *
 *   carts       — one row per active cart (per user OR per anonymous token)
 *   cart_items  — line items inside a cart
 *
 * `user_id` and `product_id` are soft links (no FK) — cross-module rule.
 * `cart_items.cart_id` is in-module and a real ON DELETE CASCADE FK to
 * `carts` (enforced in the baseline SQL).
 * Anonymous carts use a random `token` stored in a cookie; once the user
 * logs in, the workflow merges anonymous cart into their user cart.
 */

export const carts = pgTable(
  "carts",
  {
    id: id(),
    user_id: text("user_id"),
    token: text("token"), // anonymous identifier (HTTP-only cookie)
    currency: text("currency").notNull().default("TND"),
    /** When this user cart absorbed a guest cart on login, points at that source. */
    merged_from_cart_id: text("merged_from_cart_id"),
    merged_at: timestamp("merged_at", { withTimezone: true }),
    ...timestamps(),
  },
  (table) => ({
    userIdx: index("carts_user_idx").on(table.user_id),
    tokenIdx: uniqueIndex("carts_token_unique").on(table.token),
    // ONE active cart per signed-in user. This partial unique index is the linchpin
    // of getOrCreateForUser's idempotency (it catches the 23505 on a concurrent
    // create) and mergeGuestCart's concurrency safety. It lives in the baseline raw
    // SQL (0000_squash_baseline.sql) — declared HERE too so schema.ts mirrors the live
    // DB and an introspection / db:push can never offer to drop it. Migrations are
    // hand-written, so this declaration generates nothing; it is source-of-truth parity.
    userUnique: uniqueIndex("carts_user_unique")
      .on(table.user_id)
      .where(sql`${table.user_id} IS NOT NULL`),
    // Backs the merge-history lookup (a user cart that absorbed a guest cart). Also
    // baseline-raw-SQL-only until now — declared for the same parity reason.
    mergedFromIdx: index("carts_merged_from_idx")
      .on(table.merged_from_cart_id)
      .where(sql`${table.merged_from_cart_id} IS NOT NULL`),
    // Partial index serving the retention purge of ephemeral quick-buy carts
    // (cartService.purgeEphemeralOlderThan): an index scan over ONLY the qb-
    // rows, ordered by created_at, instead of a full-table seq scan. The
    // `token LIKE 'qb-%'` predicate is IMMUTABLE so it's valid here, and the
    // index stays tiny because non-ephemeral carts are excluded. See
    // migration 0026.
    ephemeralPurgeIdx: index("carts_ephemeral_purge_idx")
      .on(table.created_at)
      .where(sql`${table.token} LIKE 'qb-%'`),
  }),
);

export const cart_items = pgTable(
  "cart_items",
  {
    id: id(),
    cart_id: uuid("cart_id").notNull(),
    product_id: uuid("product_id").notNull(),
    /**
     * Selected variant (soft-FK to product_variants.id). Empty string = no
     * variant (a simple product). Empty (not NULL) so it participates cleanly
     * in the unique index below + the atomic ON CONFLICT merge in
     * `cartService.upsertItem` — two different variants of the same product
     * are distinct cart lines, while adding the same variant twice still
     * merges quantities.
     */
    variant_id: text("variant_id").notNull().default(""),
    quantity: integer("quantity").notNull().default(1),
    /** Captured at add-time so a price change mid-session doesn't surprise the user. */
    unit_price_cents: integer("unit_price_cents").notNull(),
    /**
     * Chosen Tokyo Care protection plan for this line (soft-FK to care_plans.id;
     * migration 0203). NULL = no protection. The plan must be OFFERED on the line's
     * product (scope ∪ product-include − product-exclude) and eligible — place-order
     * re-validates + re-prices server-side, so a stale/ineligible choice is dropped,
     * never trusted. Carries the selection from cart → checkout.
     */
    care_plan_id: uuid("care_plan_id"),
    ...timestamps(),
  },
  (table) => ({
    cartIdx: index("cart_items_cart_idx").on(table.cart_id),
    cartProductUnique: uniqueIndex("cart_items_cart_product_unique").on(
      table.cart_id,
      table.product_id,
      table.variant_id,
    ),
  }),
);

export type CartRow = typeof carts.$inferSelect;
export type NewCartRow = typeof carts.$inferInsert;
export type CartItemRow = typeof cart_items.$inferSelect;
export type NewCartItemRow = typeof cart_items.$inferInsert;
