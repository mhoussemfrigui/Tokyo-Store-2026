import "server-only";

import { and, desc, eq, ilike, sql, type SQL } from "drizzle-orm";

import { db, type DbOrTx } from "@/lib/db/client";
import { products } from "@/modules/catalog/product/schema";
import { getReviewConfig } from "./config";
import type { ReviewRatingSource } from "./config-parse";
import {
  product_reviews,
  type NewProductReviewRow,
  type ProductReviewRow,
  type ReviewSource,
  type ReviewStatus,
} from "./schema";

/** Escape LIKE/ILIKE metacharacters so admin search input is treated literally
 *  (the default `\` escape char applies — no ESCAPE clause needed). */
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (m) => `\\${m}`);
}

/** Moderation-list filters shared by {@link ReviewService.listForAdmin} and its count. */
type AdminReviewFilter = { status?: ReviewStatus; source?: ReviewSource; q?: string };

function adminReviewConds(opts: AdminReviewFilter): SQL | undefined {
  const conds: SQL[] = [];
  if (opts.status) conds.push(eq(product_reviews.status, opts.status));
  if (opts.source) conds.push(eq(product_reviews.source, opts.source));
  const q = opts.q?.trim();
  if (q) conds.push(ilike(products.name, `%${escapeLike(q)}%`));
  return conds.length ? and(...conds) : undefined;
}

/**
 * Extra WHERE fragment that restricts the public aggregate to GENUINE customer
 * reviews when the store is configured `reviews.rating_source = "customers"`.
 * Empty (every approved review counts) for the "all" default. Shared by the
 * per-product recompute, the bulk recompute, and the histogram so they can't
 * drift on which reviews feed the public rating. See {@link ReviewRatingSource}.
 */
function ratingSourceFrag(source: ReviewRatingSource): SQL {
  return source === "customers" ? sql` and ${product_reviews.source} = 'customer'` : sql``;
}

class ReviewService {
  async findById(id: string): Promise<ProductReviewRow | null> {
    const [row] = await db.select().from(product_reviews).where(eq(product_reviews.id, id)).limit(1);
    return row ?? null;
  }

  async findByUserAndProduct(userId: string, productId: string): Promise<ProductReviewRow | null> {
    const [row] = await db
      .select()
      .from(product_reviews)
      .where(and(eq(product_reviews.user_id, userId), eq(product_reviews.product_id, productId)))
      .limit(1);
    return row ?? null;
  }

  /**
   * Overwrite a signed-in user's own REJECTED review for a product with fresh
   * content, re-opening it for moderation. The partial-unique index caps a user
   * at one row per product, so a buyer whose review was rejected can't insert a
   * new one — they must reuse the row. Scoped to `status='rejected'` so it can
   * never clobber a pending/approved review (returns null → caller reports a
   * duplicate). `created_at` is reset so the resubmission surfaces at the top of
   * the moderation queue.
   */
  async resubmitRejected(
    userId: string,
    productId: string,
    values: Pick<NewProductReviewRow, "rating" | "title" | "body" | "status" | "verified_purchase" | "author_name">,
  ): Promise<ProductReviewRow | null> {
    const [row] = await db
      .update(product_reviews)
      .set({ ...values, source: "customer", created_at: sql`now()` })
      .where(
        and(
          eq(product_reviews.user_id, userId),
          eq(product_reviews.product_id, productId),
          eq(product_reviews.status, "rejected"),
        ),
      )
      .returning();
    return row ?? null;
  }

  async insert(input: NewProductReviewRow): Promise<ProductReviewRow> {
    const [row] = await db.insert(product_reviews).values(input).returning();
    return row;
  }

  /**
   * Batch-insert pre-built review rows (manual/AI generation). Callers set
   * `source`, `status`, `created_at` (backdating) and `user_id=null` for fakes.
   * Returns the inserted rows so the caller can recompute affected products.
   */
  async insertMany(rows: NewProductReviewRow[], txOrDb: DbOrTx = db): Promise<ProductReviewRow[]> {
    if (rows.length === 0) return [];
    return txOrDb.insert(product_reviews).values(rows).returning();
  }

  /**
   * Hard-delete every review of a given origin (admin cleanup of fakes).
   * Returns the DISTINCT product ids touched (so the caller can recompute each
   * product's stored aggregate) AND the actual number of deleted review rows
   * (so the caller can report/emit an honest count — many reviews can share a
   * product, so the row count is not the product count).
   */
  async deleteBySource(source: ReviewSource): Promise<{ productIds: string[]; deletedCount: number }> {
    const rows = await db
      .delete(product_reviews)
      .where(eq(product_reviews.source, source))
      .returning({ productId: product_reviews.product_id });
    return {
      productIds: [...new Set(rows.map((r) => r.productId))],
      deletedCount: rows.length,
    };
  }

  /**
   * Approved reviews for a product — the storefront list, newest first.
   *
   * Sorting/paging are handled client-side on the PDP "Avis" tab (it loads
   * the full approved set, capped at `limit`, then sorts/filters in the
   * browser), so this reader only needs the recent ordering + an optional
   * rating filter. No server-side `sort`/`offset` params are wired to any
   * caller, so they are intentionally not exposed here.
   */
  async listApproved(
    productId: string,
    opts: { rating?: number; limit?: number } = {},
  ): Promise<ProductReviewRow[]> {
    const conds = [
      eq(product_reviews.product_id, productId),
      eq(product_reviews.status, "approved"),
    ];
    if (opts.rating && opts.rating >= 1 && opts.rating <= 5) {
      conds.push(eq(product_reviews.rating, opts.rating));
    }
    return db
      .select()
      .from(product_reviews)
      .where(and(...conds))
      .orderBy(desc(product_reviews.created_at))
      // Floor at 1 and truncate: a 0 / negative / fractional limit from a caller
      // must never reach LIMIT as-is (0 → empty, negative → PG error).
      .limit(Math.min(Math.max(Math.trunc(opts.limit ?? 100), 1), 300));
  }

  /**
   * Read the product's STORED aggregate (products.rating / reviews_count) —
   * the columns {@link recomputeProduct} keeps fresh after every moderation
   * action. This is the headline rating shown on the PDP and emitted in the
   * JSON-LD AggregateRating. Reading the persisted value (rather than a live
   * COUNT/AVG recomputation) guarantees the on-page stars, the
   * structured data, and the product-card rating all agree — they can never
   * drift apart from a second, independently-rounded computation. The writer
   * stays {@link recomputeProduct}; this is the matching reader.
   */
  async storedAggregate(productId: string): Promise<{ count: number; average: number }> {
    const [row] = await db
      .select({ rating: products.rating, reviews_count: products.reviews_count })
      .from(products)
      .where(eq(products.id, productId))
      .limit(1);
    return {
      count: Number(row?.reviews_count ?? 0),
      average: Number(row?.rating ?? 0),
    };
  }

  /** The configured public-rating source (`reviews.rating_source`), read from
   *  settings. Falls back to "all" if settings are unavailable. */
  private async ratingSource(): Promise<ReviewRatingSource> {
    try {
      return (await getReviewConfig()).ratingSource;
    } catch {
      return "all";
    }
  }

  /**
   * Approved-review count per star (1..5) for the rating histogram. Honours the
   * `reviews.rating_source` policy so the histogram matches the headline count
   * (both customer-only when the store excludes AI/manual reviews from the public
   * rating). `source` is resolved from settings when omitted.
   */
  async distribution(productId: string, source?: ReviewRatingSource): Promise<Record<number, number>> {
    const src = source ?? (await this.ratingSource());
    const conds = [eq(product_reviews.product_id, productId), eq(product_reviews.status, "approved")];
    if (src === "customers") conds.push(eq(product_reviews.source, "customer"));
    const rows = await db
      .select({ rating: product_reviews.rating, count: sql<number>`count(*)::int` })
      .from(product_reviews)
      .where(and(...conds))
      .groupBy(product_reviews.rating);
    const dist: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    for (const r of rows) dist[Number(r.rating)] = Number(r.count);
    return dist;
  }

  /**
   * Recompute the product's stored aggregate (rating + reviews_count) from its
   * APPROVED reviews — the single source of truth for on-page stars, the JSON-LD
   * AggregateRating, and the product feeds. Call after any status change / delete.
   *
   * Honours `reviews.rating_source`: when the store excludes AI/manual reviews
   * from the public rating (`"customers"`), only genuine customer reviews feed
   * the stored aggregate. `source` is resolved from settings when omitted (the
   * moderation call sites pass nothing); pass it explicitly to avoid a settings
   * read per product in a batch, or in tests.
   */
  async recomputeProduct(
    productId: string,
    txOrDb: DbOrTx = db,
    source?: ReviewRatingSource,
  ): Promise<void> {
    const frag = ratingSourceFrag(source ?? (await this.ratingSource()));
    // Single atomic UPDATE with correlated sub-selects. Computing the aggregate
    // inside the UPDATE (rather than read-then-write) prevents a lost update
    // when two moderation actions on the same product interleave under the
    // default READ COMMITTED isolation.
    await txOrDb
      .update(products)
      .set({
        reviews_count: sql`(select count(*)::int from ${product_reviews}
          where ${product_reviews.product_id} = ${productId}
            and ${product_reviews.status} = 'approved'${frag})`,
        rating: sql`(select coalesce(round(avg(${product_reviews.rating}), 2), 0)::numeric(3,2)
          from ${product_reviews}
          where ${product_reviews.product_id} = ${productId}
            and ${product_reviews.status} = 'approved'${frag})`,
      })
      .where(eq(products.id, productId));
  }

  /**
   * Recompute EVERY product's stored aggregate under a given rating source — one
   * bulk UPDATE with correlated sub-selects (the outer `products.id` correlates
   * each row's aggregate). Called when the operator flips `reviews.rating_source`
   * so the stored stars/counts (and therefore the feeds + JSON-LD) immediately
   * reflect the new policy instead of healing one moderation action at a time.
   * Products with no matching review settle to 0/0, exactly as the per-product
   * path would.
   */
  async recomputeAll(source: ReviewRatingSource, txOrDb: DbOrTx = db): Promise<void> {
    const frag = ratingSourceFrag(source);
    await txOrDb.update(products).set({
      reviews_count: sql`(select count(*)::int from ${product_reviews}
        where ${product_reviews.product_id} = ${products.id}
          and ${product_reviews.status} = 'approved'${frag})`,
      rating: sql`(select coalesce(round(avg(${product_reviews.rating}), 2), 0)::numeric(3,2)
        from ${product_reviews}
        where ${product_reviews.product_id} = ${products.id}
          and ${product_reviews.status} = 'approved'${frag})`,
    });
  }

  // ── Admin / moderation ──────────────────────────────────────────────────
  /**
   * One page of the moderation list, newest first. `q` filters on the product
   * name (case-insensitive substring). `productDeleted` / `productPublished`
   * flag reviews whose product was soft-deleted or unpublished since — they
   * stay listed (still counted in the status badges, still moderatable) but
   * the panel must not link them to a storefront page that 404s.
   */
  async listForAdmin(
    opts: AdminReviewFilter & { limit?: number; offset?: number } = {},
  ): Promise<
    Array<{
      review: ProductReviewRow;
      productName: string | null;
      productSlug: string | null;
      productDeleted: boolean;
      productPublished: boolean;
    }>
  > {
    const rows = await db
      .select({
        review: product_reviews,
        productName: products.name,
        productSlug: products.slug,
        productDeletedAt: products.deleted_at,
        productPublished: products.is_published,
      })
      .from(product_reviews)
      .leftJoin(products, eq(products.id, product_reviews.product_id))
      .where(adminReviewConds(opts))
      .orderBy(desc(product_reviews.created_at))
      .limit(Math.min(opts.limit ?? 200, 500))
      .offset(Math.max(opts.offset ?? 0, 0));
    return rows.map(({ productDeletedAt, productPublished, ...r }) => ({
      ...r,
      // A dangling product_id (no row at all) reads as deleted too.
      productDeleted: productDeletedAt != null || r.productName == null,
      productPublished: productPublished === true,
    }));
  }

  /** Total rows matching the {@link listForAdmin} filters (for « N affichés sur M » + paging). */
  async countForAdmin(opts: AdminReviewFilter = {}): Promise<number> {
    const [row] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(product_reviews)
      .leftJoin(products, eq(products.id, product_reviews.product_id))
      .where(adminReviewConds(opts));
    return Number(row?.count ?? 0);
  }

  /** All reviews written by a user (newest first), with the product name/slug. */
  async listByUser(
    userId: string,
  ): Promise<Array<{ review: ProductReviewRow; productName: string | null; productSlug: string | null }>> {
    return db
      .select({
        review: product_reviews,
        productName: products.name,
        productSlug: products.slug,
      })
      .from(product_reviews)
      .leftJoin(products, eq(products.id, product_reviews.product_id))
      .where(eq(product_reviews.user_id, userId))
      .orderBy(desc(product_reviews.created_at))
      .limit(100);
  }

  async countByStatus(): Promise<Record<ReviewStatus, number>> {
    const rows = await db
      .select({ status: product_reviews.status, count: sql<number>`count(*)::int` })
      .from(product_reviews)
      .groupBy(product_reviews.status);
    const out: Record<ReviewStatus, number> = { pending: 0, approved: 0, rejected: 0 };
    for (const r of rows) {
      if (r.status === "pending" || r.status === "approved" || r.status === "rejected") {
        out[r.status] = Number(r.count);
      }
    }
    return out;
  }

  /**
   * The full status × source count matrix in ONE scan (`group by status, source`)
   * over every review. One grouped pass replaces the two separate full-table
   * COUNT/GROUP BY queries the admin panel used to run, and carries enough detail
   * to derive FACET-scoped badges: the per-status chips can reflect the active
   * source filter (and the per-source chips the active status), so each chip's
   * number equals what selecting it lists. The product-name search (`q`) narrows
   * the LIST + its total ({@link countForAdmin}), not these facet totals.
   */
  async statusSourceMatrix(): Promise<Record<ReviewStatus, Record<ReviewSource, number>>> {
    const rows = await db
      .select({
        status: product_reviews.status,
        source: product_reviews.source,
        count: sql<number>`count(*)::int`,
      })
      .from(product_reviews)
      .groupBy(product_reviews.status, product_reviews.source);
    const emptyRow = (): Record<ReviewSource, number> => ({ customer: 0, manual: 0, ai: 0 });
    const matrix: Record<ReviewStatus, Record<ReviewSource, number>> = {
      pending: emptyRow(),
      approved: emptyRow(),
      rejected: emptyRow(),
    };
    for (const r of rows) {
      if (
        (r.status === "pending" || r.status === "approved" || r.status === "rejected") &&
        (r.source === "customer" || r.source === "manual" || r.source === "ai")
      ) {
        matrix[r.status][r.source] += Number(r.count);
      }
    }
    return matrix;
  }

  async setStatus(id: string, status: ReviewStatus): Promise<ProductReviewRow | null> {
    const [row] = await db
      .update(product_reviews)
      .set({ status, updated_at: sql`now()` })
      .where(eq(product_reviews.id, id))
      .returning();
    return row ?? null;
  }

  async delete(id: string): Promise<ProductReviewRow | null> {
    const [row] = await db.delete(product_reviews).where(eq(product_reviews.id, id)).returning();
    return row ?? null;
  }
}

export const reviewService = new ReviewService();
