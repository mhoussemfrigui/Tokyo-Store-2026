import { sql } from "drizzle-orm";
import { boolean, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { id, timestamps } from "@/lib/db/columns";

/**
 * Wishlist / favorites. Dual identity like the cart: a signed-in user's list is
 * keyed by `user_id`, a guest's by a cookie `token`. On login the guest list is
 * merged into the user's. A partial-unique index on each column keeps one
 * list per identity.
 *
 * Public sharing (opt-in, off by default — and only when the global
 * `social.favorites_public_enabled` setting is on): a user can flip `is_public`
 * + claim a `public_slug` to expose their favorites at `/u/<slug>` under an
 * optional `public_display_name` pseudonym (real name never exposed). The slug's
 * case-insensitive uniqueness is a DB-only functional partial index (migration
 * 0057) — see below.
 */
export const wishlists = pgTable(
  "wishlists",
  {
    id: id(),
    user_id: text("user_id"),
    token: text("token"),
    /** Public-favorites opt-in (guest lists can't be public — no user_id). */
    is_public: boolean("is_public").notNull().default(false),
    /** Vanity handle for /u/<slug>; case-insensitively unique (DB-only index). */
    public_slug: text("public_slug"),
    /** Optional pseudonym shown on the public page (falls back to a generic label). */
    public_display_name: text("public_display_name"),
    /**
     * Moderation LOCK (migration 0159). An admin « Rendre privé » sets it; while
     * true the customer CANNOT re-publish (setPublicFavoritesAction refuses with a
     * « suspendu par un administrateur » message) until an admin lifts it. The
     * handle is kept (a locked list is already unreachable via is_public=false) so
     * the moderation board can still review it. A customer-initiated private toggle
     * leaves it false, so an ordinary private list is not treated as moderated.
     */
    public_locked: boolean("public_locked").notNull().default(false),
    ...timestamps(),
  },
  (t) => ({
    // Partial-unique: one list per identity. Declared here so the Drizzle
    // schema stays the source of truth and `db:generate` doesn't drift /
    // propose dropping these constraints.
    userUnique: uniqueIndex("wishlists_user_unique")
      .on(t.user_id)
      .where(sql`${t.user_id} is not null`),
    tokenUnique: uniqueIndex("wishlists_token_unique")
      .on(t.token)
      .where(sql`${t.token} is not null`),
    // Favoris moderation board (is_public OR public_locked, ordered created_at DESC —
    // publicProfileFilter / listPublicProfiles / publicProfileCount). Partial so it
    // scans only the small moderatable subset (migration 0162). Declared here to keep
    // the schema the source of truth so db:generate doesn't propose dropping it.
    moderatableIdx: index("wishlists_moderatable_idx")
      .on(t.created_at)
      .where(sql`${t.is_public} or ${t.public_locked}`),
    // NOTE: `wishlists_public_slug_uniq` — a case-insensitive functional partial
    // unique index on lower(public_slug) WHERE public_slug IS NOT NULL — exists
    // only in migration 0057's raw SQL (drizzle-kit can't express a functional
    // index, and is frozen anyway). Don't redeclare it here.
  }),
);

export const wishlist_items = pgTable(
  "wishlist_items",
  {
    id: id(),
    wishlist_id: uuid("wishlist_id").notNull(),
    product_id: uuid("product_id").notNull(),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`),
  },
  (t) => ({
    itemUnique: uniqueIndex("wishlist_items_unique").on(t.wishlist_id, t.product_id),
    productIdx: index("wishlist_items_product_idx").on(t.product_id),
  }),
);

export type WishlistRow = typeof wishlists.$inferSelect;
export type NewWishlistRow = typeof wishlists.$inferInsert;
export type WishlistItemRow = typeof wishlist_items.$inferSelect;
export type NewWishlistItemRow = typeof wishlist_items.$inferInsert;
