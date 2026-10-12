import "server-only";

import { cache } from "react";

import { getSettingsMap } from "@/modules/cms/setting/queries";
import { mediaQueries } from "@/modules/media";
import { resolveSocialList, socialUrls } from "@/lib/cms/social-list";
import { serverEnv } from "@/lib/env";
import {
  normalizeDisallowPaths,
  normalizeOrgType,
  normalizeSitemapUrls,
  parseGeoCoord,
  type OrgType,
} from "./settings-normalize";

/**
 * The single source for the brand-name + title-template DEFAULTS, so the
 * fallback can't drift across the SEO config, the root layout and llms.txt
 * (the layout previously fell back to "%s — Tokyo Store" with an em-dash while
 * this module produced "%s · {name}" with a middot).
 */
export const DEFAULT_SITE_NAME = "Tokyo Store";
export const DEFAULT_TITLE_TEMPLATE = `%s · ${DEFAULT_SITE_NAME}`;

/**
 * Global SEO configuration, admin-controlled via `seo.*` (and a few reused
 * `site.*`) settings. Powers every page's <metadata>, the JSON-LD entity graph
 * (Organization / WebSite), robots, and llms.txt. Sensible defaults keep the
 * site SEO-complete out of the box.
 */
export type SeoConfig = {
  siteUrl: string;
  siteName: string;
  titleTemplate: string; // contains "%s"
  defaultTitle: string;
  defaultDescription: string;
  /**
   * Home-page title override (`seo.title_home`). Used by the home route's
   * `generateMetadata`; defaults to the current hardcoded home headline so the
   * browser tab / social card are byte-identical until an admin sets a value.
   */
  homeTitle: string;
  /** Home-page meta description override (`seo.description_home`). Null ⇒ the
   *  per-page builder falls back to `defaultDescription`. */
  homeDescription: string | null;
  /** Site-wide meta `keywords` (`seo.keywords`, comma/newline separated).
   *  Defaults to the previous hardcoded array so the <head> is unchanged. */
  keywords: string[];
  ogImageUrl: string | null;
  ogImageMediaId: string | null;
  /**
   * The médiathèque OG image (`seo.og_image_media_id`) resolved to an ABSOLUTE
   * URL, falling back to the raw `seo.og_image_url`. Used by the JSON-LD
   * Organization logo (which needs an absolute URL), so the admin-picked
   * médiathèque image — not just the raw URL — drives the schema logo.
   */
  ogImageResolvedUrl: string | null;
  /**
   * The site LOGO MARK (`site.logo_media_id`) resolved to an ABSOLUTE URL — the
   * square-ish brand mark Google wants for `Organization.logo`, distinct from the
   * wide 1200×630 OG social card (`ogImageResolvedUrl`), which becomes the org
   * `image` instead. Null ⇒ buildOrganization falls back to the OG image.
   */
  logoResolvedUrl: string | null;
  /** Registered business identity (Réglages site → Entreprise) for the
   *  Organization node: `business.legal_name` / `business.tax_id` (matricule fiscal). */
  legalName: string | null;
  taxId: string | null;
  twitterHandle: string | null; // "@handle"
  sameAs: string[];
  knowsAbout: string[];
  contactEmail: string | null;
  contactPhone: string | null;
  address: string | null;
  /**
   * Structured address components (SEO hub → « Magasin physique »), enriching the
   * Organization/LocalBusiness `PostalAddress`. The street still comes from
   * `site.address` (Identité & contact); these add city / region / postal code.
   */
  addressLocality: string | null;
  addressRegion: string | null;
  postalCode: string | null;
  /**
   * LocalBusiness-only fields, emitted in the Organization node ONLY when
   * `orgType === "Store"` (a physical boutique): the map coordinates (`geo`) and
   * the price-range band (`priceRange`). `geoLat`/`geoLng` are validated numeric
   * (±90 / ±180) — a bad value parses to null so no invalid GeoCoordinates ships.
   */
  geoLat: number | null;
  geoLng: number | null;
  priceRange: string | null;
  robotsIndex: boolean;
  /**
   * Master switch for per-product `sameAs`. When OFF (default), the official-URL
   * field on each product's SEO tab is ignored and never emitted in the Product
   * JSON-LD — so the feature is opt-in site-wide before any product can surface
   * external links to crawlers.
   */
  productSameAsEnabled: boolean;
  /** schema.org Organization @type (admin-chosen): Organization | OnlineStore | Store. */
  orgType: OrgType;
  /** Admin-added robots.txt Disallow paths (validated site-root paths), appended to the built-in set. */
  robotsExtraDisallow: string[];
  /** Admin-added absolute sitemap URLs (resolved from path or absolute), appended to the generated sitemap. */
  sitemapExtraUrls: string[];
  /**
   * Per-content-type sitemap inclusion (all default ON). Let an admin drop a
   * whole section (e.g. exclude the blog) from the auto-generated sitemap, all
   * from the SEO tab. The static key pages + smart collections are always in.
   */
  sitemapInclude: {
    products: boolean;
    categories: boolean;
    brands: boolean;
    blog: boolean;
  };
  llmsTxt: string | null;
};

function str(v: string | null | undefined): string | null {
  const t = (v ?? "").trim();
  return t.length ? t : null;
}
function bool(v: string | null | undefined, fb: boolean): boolean {
  if (v == null) return fb;
  const s = v.trim().toLowerCase();
  if (s === "true" || s === "1" || s === "yes" || s === "on") return true;
  if (s === "false" || s === "0" || s === "no" || s === "off") return false;
  return fb;
}
function list(v: string | null | undefined): string[] {
  if (!v) return [];
  return v
    .split(/[\n,]/)
    .map((x) => x.trim())
    .filter(Boolean);
}

/**
 * Resolve the global SEO config. Wrapped in React `cache()` so the (settings +
 * média OG) reads run ONCE per request even though the layout, every page's
 * `generateMetadata`, and the JSON-LD graph each call it — they now share the
 * same memoized promise instead of re-querying `getSettingsMap` 3-4× per render.
 */
export const getSeoConfig = cache(async function getSeoConfig(): Promise<SeoConfig> {
  let s: Record<string, string | null> = {};
  try {
    s = await getSettingsMap();
  } catch {
    // settings unavailable → defaults below keep metadata/schema working
  }

  // Admin-editable canonical URL wins over the build-time-baked
  // NEXT_PUBLIC_SITE_URL (frozen at Docker build, can't change at runtime).
  // `seo.site_url` is the single canonical key — the old `site.url` alias was
  // never written by any panel/seed, so its read fallback was dead (removed).
  const siteUrl = (
    str(s["seo.site_url"]) ??
    serverEnv.NEXT_PUBLIC_SITE_URL
  ).replace(/\/$/, "");
  const siteName = str(s["site.name"]) ?? DEFAULT_SITE_NAME;
  const tagline = str(s["site.tagline"]) ?? "Votre expert en produits technologiques de pointe";
  const description =
    str(s["seo.default_description"]) ??
    str(s["site.description"]) ??
    // ~150 chars (Google's sweet spot) for an un-configured store — the crawl
    // flagged sub-90-char descriptions as too short.
    `${siteName} — iPhones, smartphones, gaming, accessoires et high-tech en Tunisie. Les meilleures marques au meilleur prix, paiement à la livraison et livraison rapide.`;

  // Resolve the médiathèque OG image to an ABSOLUTE URL (for JSON-LD + every
  // page's social card), falling back to the raw URL. `resolveSocialUrlMap` may
  // return a relative /cdn path, which we absolutise against siteUrl.
  //
  // Fallback chain so an un-themed store still gets branded social previews
  // instead of a blank card: explicit SEO OG → theme default OG
  // (`theme.default_og_media_id`) → site logo (`site.logo_media_id`). Because
  // `ogImageResolvedUrl` feeds buildPageMetadata + the JSON-LD logo, the chain
  // applies to EVERY page, not just the home/root layout.
  const ogImageMediaId = str(s["seo.og_image_media_id"]);
  const logoMediaId = str(s["site.logo_media_id"]);
  const ogMediaId = ogImageMediaId ?? str(s["theme.default_og_media_id"]) ?? logoMediaId;
  let ogImageResolvedUrl = str(s["seo.og_image_url"]);
  let logoResolvedUrl: string | null = null;
  // Resolve the OG card AND the dedicated logo mark in ONE média read.
  const idsToResolve = [...new Set([ogMediaId, logoMediaId].filter((x): x is string => Boolean(x)))];
  if (idsToResolve.length > 0) {
    try {
      const resolved = await mediaQueries.resolveSocialUrlMap(idsToResolve);
      const abs = (id: string | null): string | null => {
        const u = id ? resolved.get(id) : undefined;
        if (!u) return null;
        return u.startsWith("http") ? u : `${siteUrl}${u.startsWith("/") ? "" : "/"}${u}`;
      };
      ogImageResolvedUrl = abs(ogMediaId) ?? ogImageResolvedUrl;
      logoResolvedUrl = abs(logoMediaId);
    } catch {
      // media unavailable → keep the raw-URL fallback
    }
  }

  return {
    siteUrl,
    siteName,
    titleTemplate: str(s["seo.title_template"]) ?? `%s · ${siteName}`,
    defaultTitle: str(s["seo.default_title"]) ?? `${siteName} — ${tagline}`,
    defaultDescription: description,
    // Home headline (the title template adds the brand suffix). Default = the
    // literal that was hardcoded in the home route's generateMetadata.
    homeTitle: str(s["seo.title_home"]) ?? "iPhones, Smartphones, Gaming & High-Tech en Tunisie",
    homeDescription: str(s["seo.description_home"]),
    // Meta keywords — admin `seo.keywords` (comma/newline list) wins; otherwise
    // the previous hardcoded fallback array, preserving the <head> as-is.
    keywords:
      list(s["seo.keywords"]).length > 0
        ? list(s["seo.keywords"])
        : ["iPhone", "smartphone", "Apple", "gaming", "console", "high-tech", "accessoires", "Tunisie"],
    ogImageUrl: str(s["seo.og_image_url"]),
    ogImageMediaId,
    ogImageResolvedUrl,
    logoResolvedUrl,
    legalName: str(s["business.legal_name"]),
    taxId: str(s["business.tax_id"]),
    twitterHandle: str(s["seo.twitter_handle"]),
    // Knowledge-Graph sameAs. The SEO-specific `seo.social_*` keys (one per
    // network) are listed first, then EVERY link configured in « Identité &
    // contact » (`social.links` — now many per platform), de-duplicated. So an
    // admin who filled only one of the two panels still gets a populated
    // sameAs, and extra accounts (a second Facebook, a TikTok…) are all exposed.
    sameAs: Array.from(
      new Set(
        [
          str(s["seo.social_facebook"]),
          str(s["seo.social_instagram"]),
          str(s["seo.social_x"]),
          str(s["seo.social_linkedin"]),
          str(s["seo.social_youtube"]),
          str(s["seo.social_tiktok"]),
          ...socialUrls(resolveSocialList(s)),
        ].filter((u): u is string => Boolean(u)),
      ),
    ),
    knowsAbout: list(s["seo.knows_about"]),
    contactEmail: str(s["site.contact_email"]),
    contactPhone: str(s["site.contact_phone"]),
    address: str(s["site.address"]),
    // Structured address + LocalBusiness fields live under the SEO hub (`seo.*`)
    // so the whole « Magasin physique » schema block is editable in one place.
    addressLocality: str(s["seo.address_locality"]),
    addressRegion: str(s["seo.address_region"]),
    postalCode: str(s["seo.postal_code"]),
    geoLat: parseGeoCoord(s["seo.geo_lat"], 90),
    geoLng: parseGeoCoord(s["seo.geo_lng"], 180),
    priceRange: str(s["seo.price_range"]),
    robotsIndex: bool(s["seo.robots_index"], true),
    productSameAsEnabled: bool(s["seo.product_sameas_enabled"], false),
    orgType: normalizeOrgType(s["seo.org_type"]),
    robotsExtraDisallow: normalizeDisallowPaths(s["seo.robots_extra_disallow"]),
    sitemapExtraUrls: normalizeSitemapUrls(s["seo.sitemap_extra_urls"], siteUrl),
    sitemapInclude: {
      products: bool(s["seo.sitemap_include_products"], true),
      categories: bool(s["seo.sitemap_include_categories"], true),
      brands: bool(s["seo.sitemap_include_brands"], true),
      blog: bool(s["seo.sitemap_include_blog"], true),
    },
    llmsTxt: str(s["seo.llms_txt"]),
  };
});
