import "server-only";

import { reviewService } from "./service";

export async function listProductReviews(
  productId: string,
  opts?: { rating?: number; limit?: number },
) {
  return reviewService.listApproved(productId, opts);
}

export async function getProductReviewSummary(
  productId: string,
): Promise<{ count: number; average: number; distribution: Record<number, number> }> {
  // Headline count + average come from the STORED products.rating /
  // reviews_count columns (maintained by reviewService.recomputeProduct after
  // every moderation action), NOT a second live COUNT/AVG recomputation. This keeps the PDP
  // headline, the JSON-LD AggregateRating, and the product-card stars reading
  // one persisted source so they can't diverge from an independently-rounded
  // recomputation. The per-star distribution has no stored counterpart, so it
  // stays a live query (used only for the histogram, not the headline).
  const [agg, distribution] = await Promise.all([
    reviewService.storedAggregate(productId),
    reviewService.distribution(productId),
  ]);
  return { count: agg.count, average: agg.average, distribution };
}
