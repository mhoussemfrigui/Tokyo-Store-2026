import { boolean, index, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

import { id, timestamps } from "@/lib/db/columns";

/**
 * Newsletter subscriptions.
 *
 * Self-contained module — no FKs to users. Anonymous visitors can subscribe
 * with just an email (no account required). When a user later signs up with
 * the same email, the bridge happens at the customer-user link layer if
 * needed (no schema coupling here).
 *
 * SINGLE-OPT-IN: there is NO real confirmation gate today. The subscribe
 * workflow stamps `confirmed_at` at insert time, so every subscription is
 * auto-confirmed (`confirmed_at` ≈ `created_at`) and `is_active` is the only
 * meaningful state. The column is kept so a future double-opt-in flow can be
 * added without a migration — but until that flow exists, do NOT treat a
 * non-null `confirmed_at` as proof the address was verified.
 */

export const newsletter_subscriptions = pgTable(
  "newsletter_subscriptions",
  {
    id: id(),
    email: text("email").notNull(),
    source: text("source").notNull().default("footer"),
    is_active: boolean("is_active").notNull().default(true),
    confirmed_at: timestamp("confirmed_at", { withTimezone: true }),
    unsubscribed_at: timestamp("unsubscribed_at", { withTimezone: true }),
    ip_address: text("ip_address"),
    user_agent: text("user_agent"),
    ...timestamps(),
  },
  (table) => ({
    // This Drizzle-declared unique index is CASE-SENSITIVE on the raw column.
    // Case-insensitive uniqueness is enforced by a functional unique index
    // `newsletter_email_lower_unique` on lower(email) that lives ONLY in the
    // baseline SQL's raw tail (outside the Drizzle snapshot) — same convention
    // as `orders_contact_email_lower_idx`. Declaring it here too would make
    // drizzle-kit emit a duplicate CREATE INDEX. The DB-level lower() index is
    // the real guard; `service.insert()` also lowercases `email` on every
    // insert path so the case-sensitive index above never blocks a true dup.
    emailUnique: uniqueIndex("newsletter_email_unique").on(table.email),
    activeIdx: index("newsletter_active_idx").on(table.is_active),
  }),
);

export type NewsletterSubscriptionRow = typeof newsletter_subscriptions.$inferSelect;
export type NewNewsletterSubscriptionRow = typeof newsletter_subscriptions.$inferInsert;
