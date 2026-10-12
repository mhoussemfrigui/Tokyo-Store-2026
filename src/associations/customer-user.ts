import { pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { id, timestamps } from "@/lib/db/columns";

/**
 * Association: customer_profile ↔ auth user.
 *
 * This is the ONLY place these two modules meet. Either side stays unaware
 * of the other's internals.
 *
 *   - 1 user has 0 or 1 profile (B2B / admin users don't need one).
 *   - 1 profile belongs to exactly 1 user.
 *
 * No `references()` calls — we deliberately avoid hard FKs to keep the
 * association swappable (`user_id` points at Better-Auth's text `users.id`).
 * Integrity is application-level: the signup workflow creates the link, and
 * accounts are DISABLED, never hard-deleted (no delete-user path exists), so
 * links are never orphaned.
 *
 * NAME-MIRROR INVARIANT: `users.name` is a denormalised `${first_name} ${last_name}`
 * copy of the linked profile (read by the Utilisateurs list, audit actor names,
 * order link-candidates). It's set in lockstep at signup and kept in sync, one
 * way, by the `sync-user-name-from-profile` subscriber on `customer.profile_updated`.
 */
export const customer_user_links = pgTable(
  "customer_user_links",
  {
    id: id(),
    user_id: text("user_id").notNull(),
    customer_profile_id: uuid("customer_profile_id").notNull(),
    ...timestamps(),
  },
  (table) => ({
    // The unique indexes already cover single-column lookups on both fkeys —
    // separate cul_user_idx / cul_profile_idx were redundant (dropped in 0134).
    userUnique: uniqueIndex("cul_user_unique").on(table.user_id),
    profileUnique: uniqueIndex("cul_profile_unique").on(table.customer_profile_id),
  }),
);

export type CustomerUserLinkRow = typeof customer_user_links.$inferSelect;
export type NewCustomerUserLinkRow = typeof customer_user_links.$inferInsert;
