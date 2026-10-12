export { reviewService } from "./service";
export * as reviewQueries from "./queries";
export {
  getReviewConfig,
  type ReviewConfig,
  type ReviewPolicy,
  type ReviewRatingSource,
} from "./config";
export { REVIEW_STATUSES, REVIEW_SOURCES } from "./schema";
export type { ProductReviewRow, ReviewStatus, ReviewSource } from "./schema";
