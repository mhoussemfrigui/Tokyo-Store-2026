/**
 * PURE (no DB / no server-only) gating for the product AggregateRating + Review[]
 * structured data. Extracted from the PDP so the compliance-critical rules — the
 * ≥5-review threshold and the "customers-only" source filter — are unit-testable
 * in the fast lane and can't silently regress into advertising fabricated ratings
 * to Google / shopping feeds.
 *
 * The mapping to the schema.org shape (which pulls in the PDP's local htmlToText)
 * stays in the page; this module decides ONLY what is eligible.
 */
export type RatingSource = "all" | "customers";

/** Minimal shape needed to decide Review[] eligibility. */
export type StructuredReviewInput = {
  authorName: string | null;
  rating: number | null;
  source: string;
};

/**
 * Whether the product may emit AggregateRating / Review[] markup at all:
 * reviews must be enabled AND the store's PUBLICLY-counted review total must
 * reach the ≥5 threshold (2026 rich-results guidance + Google's thin-rating
 * scrutiny). `publicCount` is the STORED aggregate, already scoped to
 * `reviews.rating_source`, so a customers-only store with <5 genuine reviews
 * (however many AI/manual ones exist) correctly emits nothing.
 */
export function canEmitAggregateRating(
  enabled: boolean,
  publicCount: number | null | undefined,
): boolean {
  return Boolean(enabled) && typeof publicCount === "number" && publicCount >= 5;
}

/**
 * The reviews eligible for individual `Review[]` markup: those with a real author
 * + rating, and — when the store counts customers only — genuine customer
 * submissions (`source='customer'`). Never marks up an AI/manual "seed" review as
 * a real one. The caller slices to the top N and maps to schema.org shape.
 */
export function selectStructuredReviews<T extends StructuredReviewInput>(
  reviews: readonly T[],
  ratingSource: RatingSource,
): T[] {
  return reviews.filter(
    (r) =>
      Boolean(r.authorName) &&
      Boolean(r.rating) &&
      (ratingSource === "all" || r.source === "customer"),
  );
}
