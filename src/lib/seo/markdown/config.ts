import "server-only";

import { cache } from "react";

import { getSettingsMap } from "@/modules/cms/setting/queries";
import { asBool } from "@/lib/cms/setting-coerce";

/**
 * "Markdown for Agents" master switch (`seo.markdown_agents_enabled`). Default ON
 * — the feature only ever activates on an explicit agent signal (`Accept:
 * text/markdown` or a `.md` suffix), never for a normal browser, so it's safe to
 * ship enabled; the admin can still kill it from the SEO → Agents tab. The edge
 * proxy can't read the DB, so it ALWAYS rewrites a markdown-shaped request to the
 * node `/md` route, which calls this and 404s when the feature is off.
 */
export const isMarkdownAgentsEnabled = cache(async (): Promise<boolean> => {
  const map = await getSettingsMap().catch(() => ({}) as Record<string, string | null>);
  return asBool(map["seo.markdown_agents_enabled"], true);
});
