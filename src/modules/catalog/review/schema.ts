import { sql } from "drizzle-orm";
import { boolean, index, integer, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { id, timestamps } from "@/lib/db/columns";

/**
 * Product reviews. `status` gates visibility (pending → approved → rejected);
 * only `approved` rows feed the storefront list, the `products.rating` /
 * `reviews_count` aggregate, and the JSON-LD AggregateRating. `user_id` is the
 * Better Auth text id for real customer submissions; NULL for admin `manual`
 * fakes and `ai` reviews (and any legacy/guest rows). `verified_purchase` is
 * computed at write time from the user's orders containing the product that are
 * not pending, cancelled or refunded (paid → delivered all count — see
 * UNVERIFIED_ORDER_STATUSES in workflows/catalog/review.ts) and drives the
 * "Achat vérifié" badge.
 *
 * A partial UNIQUE (user_id, product_id) WHERE user_id IS NOT NULL (declared
 * below) constrains only signed-in submissions to one review per user per
 * product; the NULL-user admin/AI rows are not subject to it.
 */
export const REVIEW_STATUSES = ["pending", "approved", "rejected"] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

/**
 * Origin of a review row. `customer` = a real shopper submission; `manual` = an
 * admin-authored review (fake/seed); `ai` = bulk/scheduled AI generation. The
 * CHECK lives in the migration (mirrors the rating/status CHECKs). Lets the
 * moderation panel filter + bulk-clean fakes without touching real reviews.
 */
export const REVIEW_SOURCES = ["customer", "manual", "ai"] as const;
export type ReviewSource = (typeof REVIEW_SOURCES)[number];

export const product_reviews = pgTable(
  "product_reviews",
  {
    id: id(),
    product_id: uuid("product_id").notNull(),
    user_id: text("user_id"),
    author_name: text("author_name").notNull(),
    rating: integer("rating").notNull(), // 1..5
    title: text("title").notNull(),
    body: text("body").notNull(),
    status: text("status").$type<ReviewStatus>().notNull().default("pending"),
    source: text("source").$type<ReviewSource>().notNull().default("customer"),
    verified_purchase: boolean("verified_purchase").notNull().default(false),
    ...timestamps(),
  },
  (t) => ({
    // Covering index for listApproved (filter product_id+status, ORDER BY
    // created_at DESC) — index-ordered, no sort. Serves the (product_id) /
    // (product_id, status) prefixes too. See migration 0136.
    productStatusCreatedIdx: index("product_reviews_product_status_created_idx").on(
      t.product_id,
      t.status,
      t.created_at.desc(),
    ),
    userIdx: index("product_reviews_user_idx").on(t.user_id),
    sourceIdx: index("product_reviews_source_idx").on(t.source),
    // The admin moderation list (listForAdmin) and the per-user list order by
    // created_at DESC; without this the optional status/source filter still
    // forces a full sort of the matched rows. Added in migration 0063.
    createdIdx: index("product_reviews_created_idx").on(t.created_at.desc()),
    // One review per signed-in user per product. Declared here so the
    // schema stays the source of truth for db:generate.
    userProductUnique: uniqueIndex("product_reviews_user_product_unique")
      .on(t.user_id, t.product_id)
      .where(sql`${t.user_id} is not null`),
  }),
);

export type ProductReviewRow = typeof product_reviews.$inferSelect;
export type NewProductReviewRow = typeof product_reviews.$inferInsert;
