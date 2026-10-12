import { getSeoConfig } from "@/lib/seo/config";
import { getFeedConfig } from "@/lib/seo/feeds/config";
import { isMarkdownAgentsEnabled } from "@/lib/seo/markdown/config";
import { buildRobotsTxt } from "@/lib/seo/robots-txt";
import { resolvePublicOrigin } from "@/lib/url/public-origin";
import { isSiteGatedForViewer } from "@/lib/site-mode/config";

/**
 * /robots.txt — a RAW route handler (not the MetadataRoute convention) so we get
 * full text control: comments, the llms.txt pointer, per-feature Allow carve-outs
 * and the enabled-feed references. Replaces the former src/app/robots.ts.
 *
 * force-dynamic: robots.txt is driven by admin settings (the seo.robots_index
 * master switch, seo.robots_extra_disallow, the feed/Markdown activation toggles,
 * seo.site_url). Without per-request render Next would statically prerender it at
 * BUILD time, baking stale rules until a redeploy.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  const [seo, feeds, markdownEnabled, origin, siteClosed] = await Promise.all([
    getSeoConfig().catch(() => null),
    getFeedConfig().catch(() => null),
    // Default TRUE on a settings-read failure to MATCH the feature's own fail-open
    // default (isMarkdownAgentsEnabled defaults ON) — so robots.txt still Disallows
    // the live /md twins during a transient DB hiccup rather than under-blocking.
    isMarkdownAgentsEnabled().catch(() => true),
    // ONE origin source of truth, shared with sitemap / llms / emails.
    resolvePublicOrigin(),
    // Maintenance / coming-soon ⇒ `Disallow: /` (no staff bypass: robots.txt is
    // cookie-free). Fails OPEN like the storefront gate (settings error ⇒ live).
    isSiteGatedForViewer({ allowStaff: false }).catch(() => false),
  ]);

  const body = buildRobotsTxt({
    origin,
    siteName: seo?.siteName ?? "Tokyo Store",
    indexable: seo?.robotsIndex ?? true,
    extraDisallow: seo?.robotsExtraDisallow ?? [],
    feeds: {
      google: {
        enabled: feeds?.google.enabled ?? false,
        path: feeds?.google.path ?? "google-merchant.xml",
      },
      acp: { enabled: feeds?.acp.enabled ?? false, path: feeds?.acp.path ?? "agentic.json" },
    },
    markdownEnabled,
    siteClosed,
  });

  return new Response(body, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      // Crawlers re-fetch robots.txt often; a short shared cache spares the DB
      // without making admin toggles wait long to propagate. The CLOSED body is
      // never shared-cached, so re-opening the store unblocks crawlers at once.
      "cache-control": siteClosed ? "no-store" : "public, max-age=300, s-maxage=900",
    },
  });
}
