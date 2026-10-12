/**
 * Canonical cache-tag vocabulary — the SINGLE source for every `revalidateTag`
 * key in the app.
 *
 * STATUS: `'use cache'` is live for the high-traffic CATALOG reads, with INSTANT
 * tag invalidation (a write emits an event, the matching `invalidate-*-cache`
 * subscriber calls `bustCacheTag` = `revalidateTag(tag, {expire:0})`, the read
 * recomputes on next access — read-your-writes). `cacheLife("hours")` is only the
 * fallback ceiling. Cached readers (see /admin/system/performance → Cache):
 *   • brands     → listActiveBrands / getBrandBySlug              (tag `brands`)
 *   • categories → listCategories / getCategoryBySlug (+ counts)  (`categories` + `products:list`)
 *   • PDP        → getProductWithRowBySlug — DECLARES every embedded entity's tag
 *                  (`products:list` + `products` + `brands` + `categories` +
 *                  `product:<id>` + `product:slug:<slug>`) so a product, stock
 *                  (sale/edit/restock), review, brand, category, OR attribute
 *                  write refreshes it.
 *   • blog       → listPublishedPosts                             (`blog:posts` + `blog:categories`)
 * Two non-`'use cache'` readers also hold a tag: the /api/track consent gate
 * (`unstable_cache`, tag `site:settings`) and the search alias loader
 * (`ttlCached`, tag `search:aliases`).
 * The storefront GRIDS (category/brand product lists) stay UNCACHED on purpose.
 *
 * NOTE: the attribute subscriber busts the broad `products` tag (the PDP carries
 * it); the catalog subscriber busts `products:list` + `product:<id>` /
 * `product:slug:<slug>`.
 *
 * RESERVED — entries marked "no reader yet" below are busted by their
 * subscribers (forward-wiring) but NO cached read declares them today, so those
 * busts are no-ops: CMS/blog-tag/attribute reads are NOT cross-request
 * cached. Adding a cached reader for one of them = declare the tag in it (and
 * list it above + on the performance page); don't assume the bust already
 * protects a new cache.
 */
export const CACHE_TAGS = {
  // Catalog
  products: "products",
  productsList: "products:list",
  categories: "categories",
  brands: "brands",
  attributes: "attributes", // read by getProductSpecs (PDP specs); busted by invalidate-attribute-cache
  // Blog
  blogPosts: "blog:posts",
  blogCategories: "blog:categories",
  blogTags: "blog:tags", // reserved — no reader yet
  // CMS / chrome — only `site:settings` has a reader (the /api/track gate);
  // the rest are reserved, no reader yet
  banners: "banners",
  settings: "site:settings",
  faqs: "faqs",
  nav: "nav",
  pages: "pages",
  // Search
  searchAliases: "search:aliases",
} as const;

/** Dynamic (entity-keyed) cache-tag builders. Only `product` / `productSlug`
 *  have a reader (the PDP); the rest are reserved — no reader yet. */
export const cacheTag = {
  product: (id: string) => `product:${id}`,
  productSlug: (slug: string) => `product:slug:${slug}`,
  blogPostSlug: (slug: string) => `blog:post:slug:${slug}`,
  blogCategory: (id: string) => `blog:category:${id}`,
  bannersPlacement: (placement: string) => `banners:${placement}`,
  faqsScope: (scope: string) => `faqs:${scope}`,
  navKey: (key: string) => `nav:${key}`,
  navMenu: (menuId: string) => `nav:menu:${menuId}`,
  pageSlug: (slug: string) => `page:slug:${slug}`,
} as const;
