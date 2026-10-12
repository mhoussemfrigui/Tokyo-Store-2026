import type { ReviewStatus } from "./schema";

/**
 * Single source of truth for the review-status display vocabulary — labels and
 * badge tone classes. Mirrors the structure of `@/lib/order/status`.
 *
 * Consumed by the admin reviews moderation panel and the customer detail
 * page. Keyed by the canonical `ReviewStatus` union so a new status can't
 * be half-added.
 *
 * Isomorphic + client-safe: only a type import from the schema (erased at
 * build), no server-only deps.
 */
export type { ReviewStatus };

/** Display badge label. One canonical set everywhere. */
export const REVIEW_STATUS_LABELS: Record<ReviewStatus, string> = {
  pending: "En attente",
  approved: "Publié",
  rejected: "Rejeté",
};

/** Badge tone classes (Tailwind). */
export const REVIEW_STATUS_COLORS: Record<ReviewStatus, string> = {
  pending: "bg-amber-500/10 text-amber-600",
  approved: "bg-emerald-500/10 text-emerald-600",
  rejected: "bg-destructive/10 text-destructive",
};
