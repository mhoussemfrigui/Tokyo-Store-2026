import "server-only";

import { resolveProductRow, type ProductRef } from "./products";
import { reviewQueries } from "@/modules/catalog/review";
import { getReviewConfig } from "@/modules/catalog/review/config";

/**
 * Headless reviews read API — approved reviews + the stored aggregate for one
 * product, addressed by any product reference. Internal fields (user_id,
 * `source` = customer/manual/ai, status) are never exposed.
 */
export type ApiReview = {
  authorName: string;
  rating: number;
  title: string;
  body: string;
  verifiedPurchase: boolean;
  createdAt: string;
};

export type ApiProductReviews = {
  summary: { count: number; average: number; distribution: Record<number, number> };
  items: ApiReview[];
};

/** What a public caller gets while the review feature is switched OFF. */
function emptyReviews(): ApiProductReviews {
  return { summary: { count: 0, average: 0, distribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 } }, items: [] };
}

/**
 * Returns null when the product reference resolves to nothing OR resolves to a
 * draft and the caller isn't trusted (caller → 404). `rating` filters to a
 * single star bucket; `limit` is bounded by the caller.
 *
 * Draft contract — mirrors the products by-ref API (`getApiProductByRef`): a
 * PUBLIC (toggled) caller must never confirm a draft product exists nor read
 * reviews seeded on it; a TRUSTED keyed caller passes `includeUnpublished` to
 * read drafts back. Without this, the reviews surface would leak draft products.
 *
 * `public` (anonymous toggled caller) adds the storefront gate the PDP applies,
 * so the headless surface can't contradict it:
 *   • the `reviews.enabled` master switch — OFF ⇒ an EMPTY list + zero summary
 *     (the PDP hides reviews and the AggregateRating then).
 * Keyed ERP callers keep the full read (like every other keyed read).
 */
export async function getApiProductReviews(
  ref: ProductRef,
  opts: { rating?: number; limit?: number; includeUnpublished?: boolean; public?: boolean } = {},
): Promise<ApiProductReviews | null> {
  const product = await resolveProductRow(ref);
  if (!product) return null;
  if (!opts.includeUnpublished && !product.is_published) return null;

  if (opts.public) {
    const config = await getReviewConfig();
    if (!config.enabled) return emptyReviews();
  }

  const [rows, summary] = await Promise.all([
    reviewQueries.listProductReviews(product.id, { rating: opts.rating, limit: opts.limit }),
    reviewQueries.getProductReviewSummary(product.id),
  ]);

  return {
    summary,
    items: rows.map((r) => ({
      authorName: r.author_name,
      rating: r.rating,
      title: r.title,
      body: r.body,
      verifiedPurchase: r.verified_purchase,
      createdAt: r.created_at.toISOString(),
    })),
  };
}
