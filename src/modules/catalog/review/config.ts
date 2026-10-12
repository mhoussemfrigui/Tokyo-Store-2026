import "server-only";

import { getSettingsMap } from "@/modules/cms/setting/queries";
import {
  resolveReviewConfig,
  type ReviewConfig,
  type ReviewPolicy,
  type ReviewRatingSource,
} from "./config-parse";

/**
 * Admin-controlled review policy (site_settings `reviews.*`):
 *   reviews.enabled          — master on/off for the whole review feature
 *   reviews.policy           — "all" (any signed-in user) | "buyers_only"
 *   reviews.require_approval — new reviews start "pending" until an admin approves
 *   reviews.rating_source    — "all" | "customers" (which reviews count toward the
 *                              PUBLIC star rating + structured data + feeds)
 *
 * Defaults: enabled, open to all signed-in users, moderated, rating from all
 * approved reviews. The pure parsing + defaults live in ./config-parse
 * (unit-tested, no-DB); this wraps the settings read.
 */
export type { ReviewConfig, ReviewPolicy, ReviewRatingSource };

export async function getReviewConfig(): Promise<ReviewConfig> {
  let s: Record<string, string | null> = {};
  try {
    s = await getSettingsMap();
  } catch {
    // settings unavailable — sensible defaults keep the feature working
  }
  return resolveReviewConfig(s);
}
