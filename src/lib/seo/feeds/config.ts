import "server-only";

import { cache } from "react";

import { getSettingsMap } from "@/modules/cms/setting/queries";
import { resolvePublicOrigin } from "@/lib/url/public-origin";
import { resolveFeedConfig, type FeedConfig } from "./normalize";

/**
 * Request-cached FeedConfig reader. Pulls the raw `seo.feed_*` settings + the
 * runtime origin (seo.site_url override) + the store name, and assembles them via
 * the pure `resolveFeedConfig`. The feed routes call this; defaults are safe
 * (feeds OFF) so a never-configured store serves nothing.
 */
export const getFeedConfig = cache(async (): Promise<FeedConfig> => {
  const [map, origin] = await Promise.all([
    getSettingsMap().catch(() => ({}) as Record<string, string | null>),
    resolvePublicOrigin().catch(() => ""),
  ]);
  const siteName = map["site.name"]?.trim() || "Tokyo Store";
  return resolveFeedConfig(map, { origin, siteName });
});

export type { FeedConfig } from "./normalize";
