import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { id, softDelete, timestamps } from "@/lib/db/columns";

/**
 * Blog module — fully relational, no JSON content.
 *
 *   blog_categories  — taxonomy (one root level for now)
 *   blog_tags        — flat tag pool, joined to posts via blog_post_tags
 *   blog_posts       — the actual articles (HTML body from TipTap)
 *   blog_post_tags   — N-N join INSIDE the module (real CASCADE FKs in
 *                      the baseline)
 *
 * Authors are soft-linked to `users.id` (cross-module rule — no FK).
 * Featured images are soft-linked to `media.id`.
 *
 * blog_posts.category_id has a DB-enforced FK → blog_categories(id) ON DELETE
 * SET NULL + a `published ⇒ published_at NOT NULL` CHECK, both added in
 * migration 0059 (db:generate is frozen, so they live in SQL not `.references()`).
 *
 * MIGRATION-ONLY objects NOT modelled here (also because generate is frozen):
 * `blog_posts.search_vector` (a GENERATED tsvector over title/excerpt/body) +
 * its GIN index, a title trigram GIN, and partial `active_recent` /
 * `category_recent` indexes — all in the 0000 baseline. The admin/storefront
 * ORDER BY uses `published_at DESC NULLS LAST` to stay aligned with the partial
 * indexes. Don't run `pnpm db:generate` (it would drop them); migrations are
 * hand-authored.
 */

export const blog_categories = pgTable(
  "blog_categories",
  {
    id: id(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    display_order: integer("display_order").notNull().default(0),
    is_active: boolean("is_active").notNull().default(true),
    /** Per-category SEO overrides (migration 0186). Empty → title falls back to
     *  the name, description to `description`; `noindex` force-excludes the page. */
    meta_title: text("meta_title"),
    meta_description: text("meta_description"),
    noindex: boolean("noindex").notNull().default(false),
    ...timestamps(),
  },
  (table) => ({
    slugUnique: uniqueIndex("blog_categories_slug_unique").on(table.slug),
    orderIdx: index("blog_categories_order_idx").on(table.display_order),
  }),
);

export const blog_tags = pgTable(
  "blog_tags",
  {
    id: id(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    ...timestamps(),
  },
  (table) => ({
    slugUnique: uniqueIndex("blog_tags_slug_unique").on(table.slug),
  }),
);

export const blog_posts = pgTable(
  "blog_posts",
  {
    id: id(),
    slug: text("slug").notNull(),
    title: text("title").notNull(),
    excerpt: text("excerpt"),
    /** Rich text HTML (sanitize with DOMPurify on render). */
    body: text("body").notNull().default(""),
    category_id: uuid("category_id"), // FK → blog_categories(id) ON DELETE SET NULL (DB-enforced, migration 0059)
    /** Soft link to users.id (no FK — cross-module): the staff who SAVED the row. */
    author_user_id: text("author_user_id"),
    /**
     * Editorial AUTHOR profile — the admin-chosen schema.org Person for the byline
     * + `author` JSON-LD. DB-enforced FK → authors(id) ON DELETE SET NULL
     * (migration 0184). NULL = no editorial author (byline falls back to
     * author_user_id's name, else the Organization).
     */
    author_id: uuid("author_id"),
    /** Soft link to media.id. */
    featured_image_media_id: text("featured_image_media_id"),
    reading_minutes: integer("reading_minutes"),
    is_published: boolean("is_published").notNull().default(false),
    published_at: timestamp("published_at", { withTimezone: true }),
    meta_title: text("meta_title"),
    meta_description: text("meta_description"),
    ...timestamps(),
    ...softDelete(),
  },
  (table) => ({
    slugUnique: uniqueIndex("blog_posts_slug_unique").on(table.slug),
    categoryIdx: index("blog_posts_category_idx").on(table.category_id),
    authorIdx: index("blog_posts_author_idx").on(table.author_user_id),
    authorProfileIdx: index("blog_posts_author_id_idx").on(table.author_id),
    publishedIdx: index("blog_posts_published_idx").on(
      table.is_published,
      table.published_at,
    ),
  }),
);

export const blog_post_tags = pgTable(
  "blog_post_tags",
  {
    id: id(),
    post_id: uuid("post_id").notNull(),
    tag_id: uuid("tag_id").notNull(),
    ...timestamps(),
  },
  (table) => ({
    pairUnique: uniqueIndex("blog_post_tags_pair_unique").on(table.post_id, table.tag_id),
    postIdx: index("blog_post_tags_post_idx").on(table.post_id),
    tagIdx: index("blog_post_tags_tag_idx").on(table.tag_id),
  }),
);

/**
 * Products CITED in an article (« Cités dans l'article » rail) — an ORDERED N-N
 * link from a post to catalogue products (migration 0212). `product_id` is a
 * soft link to `products.id` (cross-module — no FK; the storefront enrich resolves
 * it to a live product card and drops unpublished/missing ids). `display_order`
 * keeps the operator's chosen order. A real FK → blog_posts(id) ON DELETE CASCADE
 * lives in the migration (db:generate frozen).
 */
export const blog_post_products = pgTable(
  "blog_post_products",
  {
    id: id(),
    post_id: uuid("post_id").notNull(),
    product_id: uuid("product_id").notNull(),
    display_order: integer("display_order").notNull().default(0),
    ...timestamps(),
  },
  (table) => ({
    pairUnique: uniqueIndex("blog_post_products_pair_unique").on(table.post_id, table.product_id),
    postIdx: index("blog_post_products_post_idx").on(table.post_id),
    productIdx: index("blog_post_products_product_idx").on(table.product_id),
  }),
);

/**
 * Reader comments + optional 1–5 star ratings on a blog post (migration 0185).
 * ACCOUNT-ONLY: `user_id` is the Better Auth id (required); `author_name` is a
 * snapshot of the display name at submit time (survives a rename / account
 * deletion). `status` gates visibility — only `approved` rows render publicly and
 * feed the post's AggregateRating. `rating` is NULLable (a comment without a star
 * rating). `parent_id` (migration 0187) threads replies: NULL = a top-level
 * comment (carries the optional rating), set = a reply (rating always NULL). A
 * partial UNIQUE (user_id, post_id) WHERE parent_id IS NULL AND deleted_at IS NULL
 * enforces one TOP-LEVEL comment per reader per post (review-style — a resubmit
 * updates it) so the aggregate counts one rating per reader; replies are
 * unlimited. FKs → blog_posts / blog_comments ON DELETE CASCADE + the
 * rating/status CHECKs live in migrations 0185/0187 (db:generate frozen).
 */
export const BLOG_COMMENT_STATUSES = ["pending", "approved", "rejected"] as const;
export type BlogCommentStatus = (typeof BLOG_COMMENT_STATUSES)[number];

export const blog_comments = pgTable(
  "blog_comments",
  {
    id: id(),
    post_id: uuid("post_id").notNull(),
    /** Reply target — NULL = top-level, set = a reply (FK → blog_comments, CASCADE). */
    parent_id: uuid("parent_id"),
    /** Better Auth user id (account-only commenting). */
    user_id: text("user_id").notNull(),
    /** Display-name snapshot at submit time. */
    author_name: text("author_name").notNull(),
    body: text("body").notNull(),
    /** Optional 1..5 star rating (CHECK in migration); NULL = reply or comment sans note. */
    rating: integer("rating"),
    status: text("status").$type<BlogCommentStatus>().notNull().default("pending"),
    ...timestamps(),
    ...softDelete(),
  },
  (t) => ({
    // The admin moderation queue (filter post_id+status, ORDER BY created_at DESC)
    // + its (post_id) / (post_id,status) prefixes.
    postStatusCreatedIdx: index("blog_comments_post_status_created_idx").on(
      t.post_id,
      t.status,
      t.created_at.desc(),
    ),
    statusCreatedIdx: index("blog_comments_status_created_idx").on(t.status, t.created_at.desc()),
    userIdx: index("blog_comments_user_idx").on(t.user_id),
    parentIdx: index("blog_comments_parent_idx").on(t.parent_id),
    // The storefront thread keyset: listApprovedTopLevel (post_id =, parent_id IS
    // NULL, status='approved', deleted_at IS NULL, id < cursor, ORDER BY id DESC).
    // post_id leads (equality), id DESC serves the range + order, the predicate
    // folds in the rest. Also serves getAggregate. Real index in migration 0188.
    postTopLevelIdx: index("blog_comments_post_toplevel_idx")
      .on(t.post_id, t.id.desc())
      .where(sql`${t.parent_id} is null and ${t.status} = 'approved' and ${t.deleted_at} is null`),
    // One (live) TOP-LEVEL comment per reader per post. Declared here as the source
    // of truth; the real partial index is in migration 0187 (0185 before parent_id).
    userPostUnique: uniqueIndex("blog_comments_user_post_unique")
      .on(t.user_id, t.post_id)
      .where(sql`${t.parent_id} is null and ${t.deleted_at} is null`),
  }),
);

export type BlogCommentRow = typeof blog_comments.$inferSelect;
export type NewBlogCommentRow = typeof blog_comments.$inferInsert;

export type BlogCategoryRow = typeof blog_categories.$inferSelect;
export type BlogTagRow = typeof blog_tags.$inferSelect;
export type BlogPostRow = typeof blog_posts.$inferSelect;
export type BlogPostProductRow = typeof blog_post_products.$inferSelect;
export type NewBlogCategoryRow = typeof blog_categories.$inferInsert;
export type NewBlogPostRow = typeof blog_posts.$inferInsert;
export type NewBlogTagRow = typeof blog_tags.$inferInsert;
