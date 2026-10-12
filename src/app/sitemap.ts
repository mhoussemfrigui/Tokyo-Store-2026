import type { MetadataRoute } from "next";

import { COLLECTION_SLUGS, getCollectionPageConfig } from "@/lib/pages/collection-page-config";
import { productQueries } from "@/modules/catalog/product";
import { categoryQueries } from "@/modules/catalog/category";
import { listCategories } from "@/lib/api/categories";
import { productCategoryLinks, productBrandLink } from "@/associations/catalog.service";
import { blogQueries } from "@/modules/blog";
import { authorQueries } from "@/modules/authors";
import { brandQueries } from "@/modules/catalog/brand";
import { pageQueries } from "@/modules/cms/page";
import { getSystemPageDefault } from "@/lib/legal/system-page-content";
import { getSeoConfig } from "@/lib/seo/config";
import { resolvePublicOrigin } from "@/lib/url/public-origin";
import { isSiteGatedForViewer } from "@/lib/site-mode/config";
import { hasForeignCanonical } from "@/lib/seo/url-guards";

// Render per-request: the sitemap reflects the LIVE catalog + admin settings
// (the SEO-tab include toggles, sitemap_extra_urls, site_url, noindex filters).
// Without this Next statically prerenders it at BUILD time — which is exactly
// why a deployed sitemap could show only static pages: the build host baked an
// empty-catalog snapshot. force-dynamic = always fresh, auto-updates on every
// product / category / brand / page change with no redeploy.
export const dynamic = "force-dynamic";

/**
 * Storefront sitemap (2026 structure).
 *
 * Includes ONLY indexable, canonical, 200-status URLs:
 *   - key content pages (home, blog hub, legal) — NOT auth/utility pages
 *     (login, register, panier, account…), which are noindex/utility and waste
 *     crawl budget.
 *   - smart collections (nouveautes / top-ventes / promotions)
 *   - catalog: every ACTIVE, non-noindex, NON-EMPTY category AND sub-category
 *     (flat `/[slug]`), every active non-noindex brand, every published
 *     non-noindex product. A product / brand whose `canonical_url` override
 *     points ELSEWHERE (a variant / duplicate folded onto a master URL) is
 *     skipped: its page declares another URL canonical, so listing it is the
 *     "Submitted URL not selected as canonical" contradiction.
 *   - editorial: published blog posts + blog categories.
 *   - admin-added extra URLs (Système → SEO → Sitemap).
 *
 * `lastmod` uses each row's real `updated_at` / `published_at` (a genuine
 * freshness signal — not the request time). Each content type can be toggled off
 * from the SEO tab (`seo.sitemapInclude`). Every `.catch(() => [])` keeps one
 * module's DB hiccup from 500-ing the whole sitemap (Google penalises errors).
 */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  // Maintenance / coming-soon ⇒ an EMPTY sitemap: every storefront URL serves the
  // noindex gate scene, so advertising them is a contradiction, and on a
  // pre-launch store the product slugs themselves leak the catalogue. No staff
  // bypass — this machine file stays cookie-free. Fails OPEN (settings error ⇒ live).
  if (await isSiteGatedForViewer({ allowStaff: false })) return [];

  // `seo` for the include toggles + extra URLs; `siteUrl` via the ONE shared origin
  // resolver (same precedence as robots / llms / emails — no drift).
  const [seo, siteUrl] = await Promise.all([
    getSeoConfig().catch(() => null),
    resolvePublicOrigin(),
  ]);
  // Default everything ON when settings are unavailable.
  const inc = seo?.sitemapInclude ?? {
    products: true,
    categories: true,
    brands: true,
    blog: true,
  };

  const [
    products,
    sitemapCats,
    blogPosts,
    blogCategories,
    blogCatCounts,
    brands,
    authors,
    authorPostCounts,
  ] = await Promise.all([
    // Slug + indexing/date columns only — the sitemap needs URL + lastmod, NOT
    // the full enrich pipeline; whole published catalog (no 100 cap).
    productQueries.listPublishedProductSlugs().catch(() => []),
    // Flat list of ALL active categories — roots AND sub-categories.
    categoryQueries.listSitemapCategories().catch(() => []),
    blogQueries.listPublishedPostSlugs(1000).catch(() => []),
    // `listAllCategories` already returns ACTIVE-only categories (see service);
    // pair it with published-post counts so EMPTY (noindex) categories are dropped.
    blogQueries.listAllCategories().catch(() => []),
    blogQueries.countPublishedPostsByCategory().catch(() => new Map<string, number>()),
    brandQueries.listActiveBrands().catch(() => []),
    authorQueries.listActiveAuthors().catch(() => []),
    authorQueries.countPublishedPostsByAuthor().catch(() => new Map<string, number>()),
  ]);
  // EVERY published CMS page (custom + system). File-routed system pages (/cgu,
  // /about…) duplicate a static entry below and are deduped by URL; a published
  // page served only by /[slug] (e.g. /garantie-retours) is no longer dropped.
  const cmsPages = await pageQueries.listPublishedCustomPageSlugs().catch(() => []);
  // The file-routed system/maison pages (notre-histoire, cgv, …) are listed statically below;
  // gate each on the SAME condition its own metadata uses to decide robots indexability, so the
  // sitemap never advertises a page that emits robots:noindex (a Search Console contradiction).
  const pageStates = new Map(
    (await pageQueries.listPageStates().catch(() => [])).map((p) => [p.slug, p]),
  );
  const now = new Date();

  // Per-category subtree product counts (each category id counted as its own
  // tree root) so empty categories — root OR sub — stay out of the sitemap.
  const catCounts =
    inc.categories && sitemapCats.length > 0
      ? await productCategoryLinks
          .countProductsForCategoryTrees(sitemapCats.map((c) => c.id))
          .catch(() => new Map<string, number>())
      : new Map<string, number>();

  // Per-brand published product counts so EMPTY brands (0 live products) stay out
  // of the sitemap — a 0-product brand URL shouldn't be advertised (the brand page
  // itself stays indexable for its branded query; it's just not listed).
  const brandCounts =
    inc.brands && brands.length > 0
      ? await productBrandLink
          .countPublishedProductsForBrands(brands.map((b) => b.id))
          .catch(() => new Map<string, number>())
      : new Map<string, number>();

  // A file-routed CMS page (notre-histoire, cgv, …): listed only when its own metadata would
  // allow indexing — NOT noindex AND it renders real content (published, OR a built-in system
  // default exists). An unpublished no-default maison page emits robots:noindex, so advertising
  // it would be a Search Console contradiction.
  const cmsPage = (slug: string, priority: number, cf: "monthly" | "yearly"): MetadataRoute.Sitemap => {
    const st = pageStates.get(slug);
    const renders = (st?.isPublished ?? false) || Boolean(getSystemPageDefault(slug));
    return !st?.noindex && renders
      ? [{ url: `${siteUrl}/${slug}`, lastModified: now, priority, changeFrequency: cf }]
      : [];
  };

  // Key content pages only — NO auth/utility routes (login, register, panier,
  // account, favoris): they're noindex/utility and don't belong in a sitemap.
  const staticRoutes: MetadataRoute.Sitemap = [
    { url: `${siteUrl}/`, lastModified: now, priority: 1, changeFrequency: "daily" },
    { url: `${siteUrl}/blog`, lastModified: now, priority: 0.7, changeFrequency: "daily" },
    // Editorial + service info pages (editable CMS system pages, served by /[slug]).
    ...cmsPage("apropos", 0.5, "monthly"),
    ...cmsPage("recrutement", 0.3, "monthly"),
    ...cmsPage("aide", 0.5, "monthly"),
    ...cmsPage("livraison", 0.5, "monthly"),
    ...cmsPage("garantie", 0.5, "monthly"),
    // Legal.
    ...cmsPage("mentions", 0.2, "yearly"),
    ...cmsPage("cgv", 0.2, "yearly"),
    ...cmsPage("cgu", 0.2, "yearly"),
    ...cmsPage("confidentialite", 0.2, "yearly"),
    ...cmsPage("cookies", 0.2, "yearly"),
  ];

  // Categories + sub-categories at their canonical flat `/[slug]` URL. Skip
  // EMPTY (count 0), admin-noindexed, AND foreign-canonical ones (a category
  // folded onto a master URL) so the sitemap never advertises a thin, noindex
  // or non-canonical page (contradictions Search Console flags). The
  // foreign-canonical guard mirrors the products/brands filters below.
  const categoryRoutes: MetadataRoute.Sitemap = inc.categories
    ? sitemapCats
        .filter(
          (c) =>
            !c.noindex &&
            (catCounts.get(c.id) ?? 0) > 0 &&
            !hasForeignCanonical(c.canonical_url, `${siteUrl}/${c.slug}`),
        )
        .map((c) => ({
          url: `${siteUrl}/${c.slug}`,
          lastModified: c.updatedAt ?? now,
          priority: 0.8,
          changeFrequency: "weekly",
        }))
    : [];

  const productRoutes: MetadataRoute.Sitemap = inc.products
    ? products
        .filter((p) => !p.noindex && !hasForeignCanonical(p.canonical_url, `${siteUrl}/${p.slug}`))
        .map((p) => ({
          url: `${siteUrl}/${p.slug}`,
          lastModified: p.updated_at ?? p.published_at ?? now,
          priority: 0.7,
          changeFrequency: "weekly",
        }))
    : [];

  // Smart showcase collections — always (config-driven), only when visible + indexable.
  const collectionConfigs = await Promise.all(
    COLLECTION_SLUGS.map((s) => getCollectionPageConfig(s).catch(() => null)),
  );
  const collectionRoutes: MetadataRoute.Sitemap = collectionConfigs
    .filter((c): c is NonNullable<typeof c> => c !== null && c.visible && !c.seo.noindex)
    // No `lastModified`: a showcase has no single stored mod-time, and stamping
    // `now` churns the entry on every crawl (the same anti-pattern this file
    // avoids for brand/blog routes). `changeFrequency: daily` already signals
    // freshness.
    .map((c) => ({
      url: `${siteUrl}/${c.slug}`,
      priority: 0.85,
      changeFrequency: "daily" as const,
    }));

  const brandRoutes: MetadataRoute.Sitemap = inc.brands
    ? brands
        .filter(
          (b) =>
            !b.noindex &&
            !hasForeignCanonical(b.canonical_url, `${siteUrl}/${b.slug}`) &&
            // Drop EMPTY brands (0 live products) — don't advertise a 0-product URL.
            (brandCounts.get(b.id) ?? 0) > 0,
        )
        .map((b) => ({
          url: `${siteUrl}/${b.slug}`,
          lastModified: b.updated_at ?? now,
          priority: 0.6,
          changeFrequency: "weekly",
        }))
    : [];

  // Published CMS pages at their flat `/[slug]` URL. Deduped by URL (the final
  // `seen` filter — static entries come first and win), so a system page that
  // also has a file route, or a slug colliding with a catalog entry, is emitted
  // only once.
  const cmsPageRoutes: MetadataRoute.Sitemap = cmsPages.map((p) => ({
    url: `${siteUrl}/${p.slug}`,
    lastModified: p.updated_at ?? p.published_at ?? now,
    priority: 0.4,
    changeFrequency: "monthly",
  }));

  const blogPostRoutes: MetadataRoute.Sitemap = inc.blog
    ? blogPosts.map((p) => ({
        url: `${siteUrl}/blog/${p.slug}`,
        lastModified: p.published_at ?? p.updated_at ?? now,
        priority: 0.6,
        changeFrequency: "monthly",
      }))
    : [];

  const blogCategoryRoutes: MetadataRoute.Sitemap = inc.blog
    ? blogCategories
        // Drop empty + admin-noindexed categories — the page renders them noindex,
        // so advertising the URL would contradict its own robots directive.
        .filter((c) => !c.noindex && (blogCatCounts.get(c.id) ?? 0) > 0)
        .map((c) => ({
          url: `${siteUrl}/blog/${c.slug}`,
          // The row's real updated_at (a truthful, stable lastmod), like the brand /
          // CMS / author routes — not request time, which churns every crawl.
          lastModified: c.updated_at ?? now,
          priority: 0.5,
          changeFrequency: "weekly",
        }))
    : [];

  // Author archive pages — active, non-noindex authors with ≥1 published post (a
  // thin/empty author page renders noindex, so it's excluded here to match it).
  const authorRoutes: MetadataRoute.Sitemap = authors
    .filter((a) => !a.noindex && (authorPostCounts.get(a.id) ?? 0) > 0)
    .map((a) => ({
      url: `${siteUrl}/auteur/${a.slug}`,
      lastModified: a.updated_at ?? now,
      priority: 0.4,
      changeFrequency: "monthly",
    }));

  // Admin-added extra URLs (Système → SEO → Sitemap) — validated + absolutised in
  // getSeoConfig; deduped against everything above so a manual entry can't double
  // a catalog URL.
  const known = new Set(
    [
      ...staticRoutes,
      ...collectionRoutes,
      ...categoryRoutes,
      ...brandRoutes,
      ...cmsPageRoutes,
      ...productRoutes,
      ...blogPostRoutes,
      ...blogCategoryRoutes,
      ...authorRoutes,
    ].map((r) => r.url),
  );
  // Never expose the machine-only surfaces (product feeds + Markdown-for-agents)
  // in the sitemap — they're noindex + canonical and must stay undiscoverable to
  // crawlers. The auto-generated routes never produce them; this also guards the
  // admin-typed extra URLs against accidentally adding a /feeds/ or .md path.
  const isMachineSurface = (url: string) =>
    /\/feeds\//.test(url) || /\/md\//.test(url) || /\.md($|\?)/.test(url);
  const extraRoutes: MetadataRoute.Sitemap = (seo?.sitemapExtraUrls ?? [])
    .filter((url) => !known.has(url) && !isMachineSurface(url))
    .map((url) => ({ url, lastModified: now, priority: 0.5, changeFrequency: "monthly" }));

  // Catalog, CMS custom pages and system pages all share the flat `/[slug]`
  // namespace, so dedupe the final list by URL (first wins) — a custom page whose
  // slug collides with a category/brand/system URL must appear only once.
  const all: MetadataRoute.Sitemap = [
    ...staticRoutes,
    ...collectionRoutes,
    ...categoryRoutes,
    ...brandRoutes,
    ...cmsPageRoutes,
    ...productRoutes,
    ...blogPostRoutes,
    ...blogCategoryRoutes,
    ...authorRoutes,
    ...extraRoutes,
  ];
  const seen = new Set<string>();
  return all.filter((r) => (seen.has(r.url) ? false : (seen.add(r.url), true)));
}
