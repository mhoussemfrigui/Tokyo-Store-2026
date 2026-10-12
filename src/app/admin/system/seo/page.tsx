import type { Metadata } from "next";

import { requirePermission } from "@/lib/auth/session";
import { permissionSetAllows, resolveUserPermissions } from "@/lib/rbac/authorize";
import { WILDCARD } from "@/lib/rbac/registry";
import { getSettingsMap } from "@/modules/cms/setting/queries";
import { getSeoConfig } from "@/lib/seo/config";
import { SeoSettingsPanel } from "./seo-settings-panel";

export const metadata: Metadata = { title: "SEO & schéma" };

export default async function AdminSeoPage() {
  const session = await requirePermission("system_seo", "view");
  // Saving is system_seo:update — gate the form for UI honesty (like the Search
  // and AI pages): a view-only role sees the values read-only instead of a save
  // that 404s the page. saveSeoSettingsAction re-checks server-side.
  const perms = await resolveUserPermissions(session.user.id);
  const canUpdate = permissionSetAllows(perms, "system_seo", "update");
  // `seo.site_url` also drives payment returns, email links, invite links and the
  // printed QR codes — owner-only (`*`); saveSeoSettingsAction re-checks.
  const isOwner = perms.has(WILDCARD);
  const [s, seo] = await Promise.all([
    // No `.catch`: the form is pre-filled from this map — a swallowed read would
    // show blanks/defaults that a save writes over the live SEO config. A failure
    // reaches the admin error boundary (retry). (`seo` below is display-only.)
    getSettingsMap(),
    getSeoConfig().catch(() => null),
  ]);
  const v = (k: string) => s[k] ?? "";
  const bool = (k: string, fb: boolean) => {
    const x = (s[k] ?? "").trim().toLowerCase();
    if (["true", "1", "on", "yes"].includes(x)) return true;
    if (["false", "0", "off", "no"].includes(x)) return false;
    return fb;
  };
  // Origin + store name for the feed placeholder defaults (what an empty field
  // resolves to via resolveFeedConfig at read time).
  const origin = (seo?.siteUrl ?? "").replace(/\/$/, "");
  const siteName = s["site.name"]?.trim() || "Tokyo Store";

  return (
    <SeoSettingsPanel
      canUpdate={canUpdate}
      canEditSiteUrl={canUpdate && isOwner}
      values={{
        siteUrl: v("seo.site_url"),
        resolvedSiteUrl: seo?.siteUrl ?? "",
        titleTemplate: v("seo.title_template"),
        defaultTitle: v("seo.default_title"),
        titleHome: v("seo.title_home"),
        descriptionHome: v("seo.description_home"),
        keywords: v("seo.keywords"),
        defaultDescription: v("seo.default_description"),
        ogImageUrl: v("seo.og_image_url"),
        ogImageMediaId: v("seo.og_image_media_id"),
        // Resolved médiathèque OG URL (absolute) so the social-card preview shows
        // a media-picked image on load, not just the raw fallback URL.
        resolvedOgImageUrl: seo?.ogImageResolvedUrl ?? "",
        twitterHandle: v("seo.twitter_handle"),
        facebook: v("seo.social_facebook"),
        instagram: v("seo.social_instagram"),
        x: v("seo.social_x"),
        linkedin: v("seo.social_linkedin"),
        youtube: v("seo.social_youtube"),
        tiktok: v("seo.social_tiktok"),
        knowsAbout: v("seo.knows_about"),
        llmsTxt: v("seo.llms_txt"),
        robotsIndex: bool("seo.robots_index", true),
        productSameAsEnabled: bool("seo.product_sameas_enabled", false),
        orgType: v("seo.org_type") || "Organization",
        // « Magasin physique » (LocalBusiness) — structured address + geo + price.
        addressLocality: v("seo.address_locality"),
        addressRegion: v("seo.address_region"),
        postalCode: v("seo.postal_code"),
        geoLat: v("seo.geo_lat"),
        geoLng: v("seo.geo_lng"),
        priceRange: v("seo.price_range"),
        robotsExtraDisallow: v("seo.robots_extra_disallow"),
        sitemapExtraUrls: v("seo.sitemap_extra_urls"),
        sitemapIncludeProducts: bool("seo.sitemap_include_products", true),
        sitemapIncludeCategories: bool("seo.sitemap_include_categories", true),
        sitemapIncludeBrands: bool("seo.sitemap_include_brands", true),
        sitemapIncludeBlog: bool("seo.sitemap_include_blog", true),
        feedGoogleEnabled: bool("seo.feed_google_enabled", false),
        feedGooglePath: v("seo.feed_google_path"),
        feedAcpEnabled: bool("seo.feed_acp_enabled", false),
        feedAcpPath: v("seo.feed_acp_path"),
        feedSellerName: v("seo.feed_seller_name"),
        feedStoreCountry: v("seo.feed_store_country"),
        feedTargetCountries: v("seo.feed_target_countries"),
        feedReturnPolicyUrl: v("seo.feed_return_policy_url"),
        feedPrivacyUrl: v("seo.feed_privacy_url"),
        feedTosUrl: v("seo.feed_tos_url"),
        feedDefaults: {
          sellerName: siteName,
          returnPolicyUrl: `${origin}/cgv`,
          privacyUrl: `${origin}/privacy`,
          tosUrl: `${origin}/cgu`,
        },
        markdownAgentsEnabled: bool("seo.markdown_agents_enabled", true),
      }}
    />
  );
}
