import "server-only";

import { getSeoConfig } from "@/lib/seo/config";

/**
 * Resolve the PUBLIC origin (scheme + host, no trailing slash) for building
 * ABSOLUTE links in server contexts — transactional/marketing emails, the
 * payment-gateway return/webhook URLs, etc.
 *
 * Prefers the admin-editable `seo.site_url` setting (changeable at RUNTIME from
 * the SEO panel) over the build-baked `NEXT_PUBLIC_SITE_URL`, so a mis-built
 * Docker image whose baked origin is wrong (or a domain change) can be corrected
 * from the admin panel WITHOUT a rebuild. Falls back to the env, then localhost
 * (dev only).
 *
 * This is the ONE origin source of truth shared by the gateway payment flow and
 * every email subscriber, so on-site, payment-return and email links can never
 * silently disagree (the same `seo.site_url` ⟶ NEXT_PUBLIC_SITE_URL precedence
 * already used by the sitemap, robots.txt, root canonical/OG and llms.txt).
 * Never throws — a settings-read failure degrades to the env/localhost.
 */
export async function resolvePublicOrigin(): Promise<string> {
  const fromSeo = await getSeoConfig()
    .then((s) => s.siteUrl?.trim() || "")
    .catch(() => "");
  const base = fromSeo || process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000";
  return base.replace(/\/$/, "");
}
