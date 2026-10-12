import "server-only";

import { getSettingsMap } from "@/modules/cms/setting/queries";
import { asBool } from "@/lib/cms/setting-coerce";

/**
 * Blog comments / ratings policy (`blog.comments.*` site_settings) — the
 * admin-tunable « paramètres » of the Commentaires tab. ACCOUNT-ONLY commenting
 * is a fixed policy (per the owner); these toggle the feature, star ratings, and
 * whether a comment is held for moderation before it appears.
 */
export type BlogCommentsConfig = {
  /** Master switch — off hides the whole comments section + rejects submits. */
  enabled: boolean;
  /** Whether a comment may carry a 1–5 star rating (and the post shows an average). */
  ratingsEnabled: boolean;
  /** Pre-moderation: a new/edited comment lands `pending` (else auto-`approved`). */
  requireApproval: boolean;
  /** Max comment body length (characters). */
  maxLength: number;
};

export const BLOG_COMMENTS_DEFAULTS: BlogCommentsConfig = {
  enabled: true,
  ratingsEnabled: true,
  requireApproval: true,
  maxLength: 2000,
};

export function parseBlogCommentsConfig(s: Record<string, string | null>): BlogCommentsConfig {
  const n = Number(s["blog.comments.max_length"]);
  return {
    enabled: asBool(s["blog.comments.enabled"], BLOG_COMMENTS_DEFAULTS.enabled),
    ratingsEnabled: asBool(s["blog.comments.ratings_enabled"], BLOG_COMMENTS_DEFAULTS.ratingsEnabled),
    requireApproval: asBool(s["blog.comments.require_approval"], BLOG_COMMENTS_DEFAULTS.requireApproval),
    maxLength: Number.isFinite(n) && n >= 200 && n <= 10000 ? Math.round(n) : BLOG_COMMENTS_DEFAULTS.maxLength,
  };
}

export async function getBlogCommentsConfig(): Promise<BlogCommentsConfig> {
  const s = await getSettingsMap().catch(() => ({}) as Record<string, string | null>);
  return parseBlogCommentsConfig(s);
}
