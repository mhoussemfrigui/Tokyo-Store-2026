/**
 * PURE (no server-only / DB) resolver for the review policy stored in
 * `site_settings` `reviews.*`. Kept separate from config.ts so the parsing +
 * defaults are unit-testable in the fast (no-DB) lane; config.ts wraps this with
 * the settings read.
 */
import { asBool } from "@/lib/cms/setting-coerce";

export type ReviewPolicy = "all" | "buyers_only";
/**
 * Which reviews count toward the PUBLIC star rating — the headline stars, the
 * histogram, the PDP AggregateRating/Review[] JSON-LD, and the ACP + Merchant
 * product feeds:
 *   "customers" — only genuine customer submissions (source='customer').
 *                 AI + manual "seed" reviews still SHOW in the on-page list, but
 *                 never inflate the rating a search engine / shopping feed reads.
 *   "all"       — every approved review (customer + manual + ai) counts.
 * Default is "all" (the historical behaviour) so an existing store's stored
 * aggregates stay consistent until the operator opts in; the admin UI marks
 * "customers" as recommended for Google review-snippet + FTC compliance.
 */
export type ReviewRatingSource = "customers" | "all";
export type ReviewConfig = {
  enabled: boolean;
  policy: ReviewPolicy;
  requireApproval: boolean;
  ratingSource: ReviewRatingSource;
};

/**
 * Resolve the review config from a settings map. Defaults: enabled, open to all
 * signed-in users, moderated. Unknown `policy` → "all". Boolean settings use the
 * canonical `asBool` coercion (lib/cms/setting-coerce) so every `*.enabled`-style
 * setting parses identically.
 */
export function resolveReviewConfig(s: Record<string, string | null>): ReviewConfig {
  return {
    enabled: asBool(s["reviews.enabled"], true),
    policy: (s["reviews.policy"] ?? "").trim() === "buyers_only" ? "buyers_only" : "all",
    requireApproval: asBool(s["reviews.require_approval"], true),
    // Unknown / blank / absent → "all" (historical default).
    ratingSource: (s["reviews.rating_source"] ?? "").trim() === "customers" ? "customers" : "all",
  };
}
