import "server-only";

import type { SeoConfig } from "./config";

/**
 * JSON-LD entity-graph builders (schema.org), following the 2026 master guide:
 *   - Organization + WebSite defined ONCE (home) with stable @ids
 *   - every other page references them via @id (no repeated Organization)
 *   - one @graph block per page; BreadcrumbList on listing/detail pages
 *   - Product AggregateRating/Review come ONLY from real, visible reviews
 */

export type JsonLdNode = Record<string, unknown>;
export type JsonLdGraph = { "@context": "https://schema.org"; "@graph": JsonLdNode[] };

export const orgId = (siteUrl: string) => `${siteUrl}/#organization`;
export const websiteId = (siteUrl: string) => `${siteUrl}/#website`;

/** Resolve a possibly-relative href to an absolute URL against siteUrl. Returns
 *  the input unchanged when already absolute; null for empty/blank. */
function absoluteJsonLdUrl(siteUrl: string, u: string | null | undefined): string | null {
  const s = (u ?? "").trim();
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) return s;
  const base = siteUrl.replace(/\/$/, "");
  return `${base}${s.startsWith("/") ? "" : "/"}${s}`;
}

export function buildOrganization(seo: SeoConfig): JsonLdNode {
  const node: JsonLdNode = {
    // Admin-chosen subtype (Organization | OnlineStore | Store) — OnlineStore/
    // Store are e-commerce-specific Organization subtypes Google understands.
    // The @id stays `#organization` so every cross-page reference still resolves.
    "@type": seo.orgType,
    "@id": orgId(seo.siteUrl),
    name: seo.siteName,
    url: seo.siteUrl,
  };
  // Registered legal identity (helps Google match the real business entity).
  if (seo.legalName) node.legalName = seo.legalName;
  if (seo.taxId) node.taxID = seo.taxId;
  // `logo` wants the square-ish brand MARK (site.logo_media_id); the wide OG card
  // becomes the representative `image`. Fall back to the OG card for logo only
  // when no dedicated logo is set.
  const logoUrl = seo.logoResolvedUrl ?? seo.ogImageResolvedUrl ?? seo.ogImageUrl;
  if (logoUrl) node.logo = { "@type": "ImageObject", url: logoUrl };
  const imageUrl = seo.ogImageResolvedUrl ?? seo.ogImageUrl;
  if (imageUrl) node.image = imageUrl;
  if (seo.sameAs.length > 0) node.sameAs = seo.sameAs;
  if (seo.knowsAbout.length > 0) node.knowsAbout = seo.knowsAbout;
  // The store serves Tunisia nationwide — a national delivery business.
  node.areaServed = { "@type": "Country", name: "Tunisie" };
  // Top-level telephone (in addition to the contactPoint) — Google reads both.
  if (seo.contactPhone) node.telephone = seo.contactPhone;
  if (seo.contactPhone || seo.contactEmail) {
    const cp: JsonLdNode = { "@type": "ContactPoint", contactType: "customer service" };
    if (seo.contactPhone) cp.telephone = seo.contactPhone;
    if (seo.contactEmail) cp.email = seo.contactEmail;
    node.contactPoint = cp;
  }
  if (seo.address || seo.addressLocality || seo.addressRegion || seo.postalCode) {
    const addr: JsonLdNode = { "@type": "PostalAddress" };
    if (seo.address) addr.streetAddress = seo.address;
    if (seo.addressLocality) addr.addressLocality = seo.addressLocality;
    if (seo.addressRegion) addr.addressRegion = seo.addressRegion;
    if (seo.postalCode) addr.postalCode = seo.postalCode;
    addr.addressCountry = "TN";
    node.address = addr;
  }
  // LocalBusiness-only fields: `geo` coordinates + `priceRange` are valid on a
  // physical Store (a LocalBusiness subtype) but NOT on a plain Organization /
  // OnlineStore, so they're gated on the admin-chosen `Store` org type. The @id
  // stays `#organization` (no separate LocalBusiness node) so every cross-page
  // reference still folds into the one business entity. Fill the boutique's
  // coordinates + fourchette de prix in Système → SEO to unlock the local pack.
  if (seo.orgType === "Store") {
    if (seo.geoLat != null && seo.geoLng != null) {
      node.geo = { "@type": "GeoCoordinates", latitude: seo.geoLat, longitude: seo.geoLng };
    }
    if (seo.priceRange) node.priceRange = seo.priceRange;
  }
  return node;
}

export function buildWebSite(seo: SeoConfig): JsonLdNode {
  return {
    "@type": "WebSite",
    "@id": websiteId(seo.siteUrl),
    url: seo.siteUrl,
    name: seo.siteName,
    publisher: { "@id": orgId(seo.siteUrl) },
    potentialAction: {
      "@type": "SearchAction",
      target: {
        "@type": "EntryPoint",
        urlTemplate: `${seo.siteUrl}/recherche?q={search_term_string}`,
      },
      "query-input": "required name=search_term_string",
    },
  };
}

/**
 * Home-page global graph — the single canonical Organization + WebSite, plus the
 * home WebPage and (optionally) the main-nav SiteNavigationElement. `itemListCount`
 * is the number of product-rail ItemLists the caller ALSO merges in (via
 * buildHomeProductListsGraph): the WebPage references them by @id, so pass the
 * count of ItemLists ACTUALLY built (never the raw rail count) or the refs dangle.
 */
export function buildGlobalGraph(
  seo: SeoConfig,
  opts?: { itemListCount?: number; navItems?: Array<{ name: string; url: string }> },
): JsonLdGraph {
  const nav = opts?.navItems ? buildSiteNavigationNode(seo, opts.navItems) : null;
  return {
    "@context": "https://schema.org",
    "@graph": [
      buildOrganization(seo),
      buildWebSite(seo),
      buildHomeWebPage(seo, opts?.itemListCount ?? 0, nav ? (nav["@id"] as string) : null),
      ...(nav ? [nav] : []),
    ],
  };
}

/** The home WebPage `name` — the admin home title with the brand suffix (matching
 *  the <title> the home route renders), so the schema name + page title agree. */
function homeWebPageName(seo: SeoConfig): string {
  const title = seo.homeTitle.trim();
  if (!title) return seo.siteName;
  return title.includes(seo.siteName) ? title : `${title} · ${seo.siteName}`;
}

/**
 * The home WebPage node. Links to the shared WebSite + Organization by @id, and
 * declares the product rails (mainEntity → ItemList @ids — NOT hasPart, which is a
 * schema range error since ItemList is Intangible, not a CreativeWork) and the main
 * nav (hasPart → SiteNavigationElement, which IS a CreativeWork). Internal — only
 * buildGlobalGraph mints it, on the home page.
 */
function buildHomeWebPage(seo: SeoConfig, itemListCount: number, navId: string | null): JsonLdNode {
  const base = seo.siteUrl.replace(/\/$/, "");
  const node: JsonLdNode = {
    "@type": "WebPage",
    "@id": `${base}/#webpage`,
    url: `${base}/`,
    name: homeWebPageName(seo),
    isPartOf: { "@id": websiteId(seo.siteUrl) },
    about: { "@id": orgId(seo.siteUrl) },
    inLanguage: "fr-TN",
  };
  const description = seo.homeDescription ?? seo.defaultDescription;
  if (description) node.description = description;
  const ogImage = seo.ogImageResolvedUrl ?? seo.ogImageUrl;
  if (ogImage) node.primaryImageOfPage = { "@type": "ImageObject", url: ogImage };
  if (itemListCount > 0) {
    node.mainEntity = Array.from({ length: itemListCount }, (_, i) => ({
      "@id": `${base}/#itemlist-${i + 1}`,
    }));
  }
  if (navId) node.hasPart = { "@id": navId };
  return node;
}

/**
 * SiteNavigationElement for the main menu — the top-level nav roots as a schema
 * nav list. Absolutises each href against siteUrl, drops blanks, caps at 40.
 * Returns null for an empty menu (the caller then emits nothing).
 */
export function buildSiteNavigationNode(
  seo: SeoConfig,
  items: Array<{ name: string; url: string }>,
): JsonLdNode | null {
  const base = seo.siteUrl.replace(/\/$/, "");
  const clean = items
    .map((it) => ({
      name: (it.name ?? "").trim(),
      url: (absoluteJsonLdUrl(base, it.url) ?? "").trim(),
    }))
    .filter((it) => it.name && it.url)
    .slice(0, 40);
  if (clean.length === 0) return null;
  return {
    "@type": "SiteNavigationElement",
    "@id": `${base}/#sitenav`,
    name: "Menu principal",
    hasPart: clean.map((it, i) => ({
      "@type": "SiteNavigationElement",
      "@id": `${base}/#sitenav-${i + 1}`,
      position: i + 1,
      name: it.name,
      url: it.url,
    })),
  };
}

/**
 * One ItemList per home product rail (best-sellers, nouveautés…). URL-only
 * ListItems (no inlined Product — an incomplete Product with no live Offer reads
 * as a broken merchant listing). The @ids (`#itemlist-N`) MUST match the refs
 * buildHomeWebPage mints. Takes a bare siteUrl. Null when no rail has items.
 */
export function buildHomeProductListsGraph(
  siteUrl: string,
  lists: ReadonlyArray<{ name: string; items: ReadonlyArray<{ url: string; name?: string | null }> }>,
): JsonLdGraph | null {
  const base = siteUrl.replace(/\/$/, "");
  const nodes: JsonLdNode[] = lists
    .filter((l) => l.items.length > 0)
    .map((l, idx) => ({
      "@type": "ItemList",
      "@id": `${base}/#itemlist-${idx + 1}`,
      name: l.name,
      numberOfItems: l.items.length,
      itemListElement: l.items.map((it, i) => ({
        "@type": "ListItem",
        "@id": `${base}/#itemlist-${idx + 1}-${i + 1}`,
        position: i + 1,
        ...(it.name ? { name: it.name } : {}),
        url: absoluteJsonLdUrl(base, it.url) ?? it.url,
      })),
    }));
  if (nodes.length === 0) return null;
  return { "@context": "https://schema.org", "@graph": nodes };
}

/** Merge several @graph blocks into ONE (2026 guide: one @graph per page). */
export function mergeGraphs(...graphs: Array<JsonLdGraph | null | undefined>): JsonLdGraph {
  const nodes: JsonLdNode[] = [];
  for (const g of graphs) if (g) nodes.push(...g["@graph"]);
  return { "@context": "https://schema.org", "@graph": nodes };
}

/**
 * BreadcrumbList. Pass `idBase` (the page URL) to mint stable @ids on the list
 * (`#breadcrumb`) and each ListItem (`#breadcrumb-N`) so another node can
 * reference the trail by @id and a consumer that reads the doc twice can't
 * double-count anonymous items.
 */
export function buildBreadcrumb(
  items: Array<{ name: string; url: string }>,
  idBase?: string,
): JsonLdNode {
  return {
    "@type": "BreadcrumbList",
    ...(idBase ? { "@id": `${idBase}#breadcrumb` } : {}),
    itemListElement: items.map((it, i) => ({
      "@type": "ListItem",
      ...(idBase ? { "@id": `${idBase}#breadcrumb-${i + 1}` } : {}),
      position: i + 1,
      name: it.name,
      item: it.url,
    })),
  };
}

/** Listing pages (category, smart collections, brand): CollectionPage + Breadcrumb + ItemList. */
export function buildCollectionGraph(
  seo: SeoConfig,
  opts: {
    url: string;
    name: string;
    description?: string | null;
    breadcrumb: Array<{ name: string; url: string }>;
    /** The URLs to ENUMERATE in the ItemList (the caller may cap this window). */
    productUrls: string[];
    /**
     * The TRUE total for `numberOfItems` when the caller caps `productUrls` to a
     * window (keeps the count accurate while the enumerated payload stays small).
     * Defaults to productUrls.length when omitted.
     */
    totalItems?: number;
    /** When set, the CollectionPage gets `about: { @id }` — used on a brand
     *  landing page to link the page to its sibling Brand node (`#brand`) so the
     *  Brand isn't a graph orphan. */
    aboutId?: string;
    /** Absolute hero/representative image → `primaryImageOfPage`. */
    imageUrl?: string | null;
  },
): JsonLdGraph {
  const hasItems = opts.productUrls.length > 0;
  const graph: JsonLdNode[] = [
    {
      "@type": "CollectionPage",
      "@id": `${opts.url}#webpage`,
      url: opts.url,
      name: opts.name,
      inLanguage: "fr-TN",
      ...(opts.description ? { description: opts.description } : {}),
      ...(opts.imageUrl ? { primaryImageOfPage: { "@type": "ImageObject", url: opts.imageUrl } } : {}),
      ...(opts.aboutId ? { about: { "@id": opts.aboutId } } : {}),
      // Link the sibling BreadcrumbList by @id (buildBreadcrumb mints `#breadcrumb`).
      breadcrumb: { "@id": `${opts.url}#breadcrumb` },
      // Inline a TYPED WebSite (not a bare @id ref) so the node resolves within
      // the page document — a bare `{ "@id": "#website" }` shows up in validators
      // as an untyped "CreativeWork"/"Unspecified Type" stub. Google still folds
      // this into the full WebSite (home graph) by the shared @id.
      isPartOf: {
        "@type": "WebSite",
        "@id": websiteId(seo.siteUrl),
        url: seo.siteUrl,
        name: seo.siteName,
      },
      // Declare the product ItemList as the page's primary entity so crawlers
      // read the page as a product collection (mirrors the FAQ mainEntityOfPage
      // linkage). Only when the list actually exists.
      ...(hasItems ? { mainEntity: { "@id": `${opts.url}#itemlist` } } : {}),
    },
    buildBreadcrumb(opts.breadcrumb, opts.url),
  ];
  if (hasItems) {
    graph.push({
      "@type": "ItemList",
      "@id": `${opts.url}#itemlist`,
      numberOfItems: opts.totalItems ?? opts.productUrls.length,
      itemListElement: opts.productUrls.map((url, i) => ({
        "@type": "ListItem",
        position: i + 1,
        url,
      })),
    });
  }
  return { "@context": "https://schema.org", "@graph": graph };
}

/**
 * WebPage + BreadcrumbList for a static / CMS / legal page (notre-histoire, cgv,
 * cgu, nos-boutiques, …) that otherwise emits no structured data. A fixed 2-level
 * trail (Accueil → page) unless `breadcrumb` overrides it; the WebPage links the
 * shared WebSite inline-by-@id (folds into the home WebSite), carries the page's
 * hero image as primaryImageOfPage when set, and declares an FAQ sibling via
 * hasPart when `hasFaq`. Gate `hasFaq` on the BUILT buildFaqGraph (not the block
 * count) — an all-blank FAQ returns null and the hasPart would dangle.
 */
export function buildCmsPageGraph(
  seo: SeoConfig,
  opts: {
    url: string;
    name: string;
    description?: string | null;
    /** Absolute hero/representative image → primaryImageOfPage. */
    imageUrl?: string | null;
    /** Override the default 2-level Accueil→page trail (e.g. a nested page). */
    breadcrumb?: Array<{ name: string; url: string }>;
    hasFaq?: boolean;
  },
): JsonLdGraph {
  const trail = opts.breadcrumb ?? [
    { name: "Accueil", url: seo.siteUrl },
    { name: opts.name, url: opts.url },
  ];
  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "WebPage",
        "@id": `${opts.url}#webpage`,
        url: opts.url,
        name: opts.name,
        inLanguage: "fr-TN",
        ...(opts.description ? { description: opts.description } : {}),
        ...(opts.imageUrl
          ? { primaryImageOfPage: { "@type": "ImageObject", url: opts.imageUrl } }
          : {}),
        // Inline a TYPED WebSite (not a bare @id) so the node resolves within the
        // page document; Google folds it into the home WebSite by the shared @id.
        isPartOf: {
          "@type": "WebSite",
          "@id": websiteId(seo.siteUrl),
          url: seo.siteUrl,
          name: seo.siteName,
        },
        breadcrumb: { "@id": `${opts.url}#breadcrumb` },
        ...(opts.hasFaq ? { hasPart: { "@id": `${opts.url}#faq` } } : {}),
      },
      buildBreadcrumb(trail, opts.url),
    ],
  };
}

/**
 * schema.org Brand entity for a brand landing page — a real-world Brand node
 * (name, url, logo, description) with a stable `@id` so the brand folds into one
 * entity for the knowledge graph (and PDP `brand` mentions can reference it).
 * Emitted ALONGSIDE the CollectionPage graph (which lists the brand's products).
 */
export function buildBrandGraph(opts: {
  url: string;
  name: string;
  description?: string | null;
  logoUrl?: string | null;
  /** Stable base for the Brand `@id` (defaults to `url`). Pass the canonical
   *  SITE url (`${siteUrl}/${slug}`), NOT a per-brand canonical_url override, so a
   *  PDP that references `${siteUrl}/${brandSlug}#brand` folds into the SAME Brand
   *  entity even when the brand page sets a different canonical. */
  idUrl?: string;
}): JsonLdGraph {
  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Brand",
        "@id": `${opts.idUrl ?? opts.url}#brand`,
        name: opts.name,
        url: opts.url,
        ...(opts.description ? { description: opts.description } : {}),
        ...(opts.logoUrl ? { logo: opts.logoUrl } : {}),
      },
    ],
  };
}

/**
 * Full PRODUCT detail graph for the PDP: a Product node (with Offer, optional
 * AggregateRating + Review[], merchant identifiers, sameAs), a BreadcrumbList,
 * and — when provided — a VideoObject and an FAQPage, merged into ONE @graph
 * (2026 guide: one @graph per page). Replaces the hand-rolled inline Product LD
 * so the compliance-critical bits (sku vs id, ≥5 rating gate, condition map,
 * price validity, seller @id) live in one tested place.
 *
 * The caller PRE-GATES the rating (pass null unless `canEmitAggregateRating`) and
 * PRE-FILTERS the reviews (via `selectStructuredReviews`). Images, breadcrumb URLs
 * and the offer url MUST already be absolute (built from `seo.siteUrl`), so the
 * graph never mixes a build-time origin with the admin canonical origin.
 */
export function buildProductGraph(
  seo: SeoConfig,
  opts: {
    /** Canonical PDP url (absolute) — the node @id base + the Offer url. */
    url: string;
    name: string;
    description?: string | null;
    /** Gallery image URLs (absolute / same-origin), primary first. */
    images: string[];
    sku?: string | null;
    gtin?: string | null;
    mpn?: string | null;
    brand?: string | null;
    /** Official/brand links — caller passes [] unless the global switch is on. */
    sameAs?: string[];
    /** Pre-gated (≥5) aggregate, or null to omit. */
    rating?: { value: number; count: number } | null;
    /** Pre-filtered reviews for Review[] markup. */
    reviews?: Array<{
      author: string;
      rating: number;
      title?: string | null;
      body?: string | null;
      date?: string | null;
    }>;
    offer: {
      price: number;
      currency: string;
      /** schema.org availability URL. */
      availability: string;
      /** schema.org itemCondition URL. */
      itemCondition: string;
      validFrom?: string;
      priceValidUntil?: string;
      /** Real shipping fee (from the delivery backend) → OfferShippingDetails. Null omits it. */
      shippingRate?: { value: number; currency: string } | null;
    };
    breadcrumb: Array<{ name: string; url: string }>;
    /** VideoObject node (from `buildProductVideoLd`), already carrying its own @id. */
    video?: JsonLdNode | null;
    /** Admin FAQ (plain text) → FAQPage; omitted when empty. */
    faqs?: Array<{ question: string; answer: string }>;
  },
): JsonLdGraph {
  const offerNode: JsonLdNode = {
    "@type": "Offer",
    url: opts.url,
    priceCurrency: opts.offer.currency,
    price: opts.offer.price,
    itemCondition: opts.offer.itemCondition,
    availability: opts.offer.availability,
    // Reference the single Organization entity by @id (defined once on home); name
    // it so the node is a typed reference, not a dangling @id.
    seller: { "@type": "Organization", "@id": orgId(seo.siteUrl), name: seo.siteName },
  };
  if (opts.offer.validFrom) offerNode.validFrom = opts.offer.validFrom;
  if (opts.offer.priceValidUntil) offerNode.priceValidUntil = opts.offer.priceValidUntil;
  if (opts.offer.shippingRate) {
    offerNode.shippingDetails = {
      "@type": "OfferShippingDetails",
      shippingRate: {
        "@type": "MonetaryAmount",
        value: opts.offer.shippingRate.value,
        currency: opts.offer.shippingRate.currency,
      },
      shippingDestination: { "@type": "DefinedRegion", addressCountry: "TN" },
    };
  }

  const product: JsonLdNode = {
    "@type": "Product",
    "@id": `${opts.url}#product`,
    name: opts.name,
    image: opts.images.length > 0 ? opts.images : undefined,
    offers: offerNode,
  };
  if (opts.description) product.description = opts.description;
  if (opts.sku) product.sku = opts.sku;
  if (opts.gtin) product.gtin = opts.gtin;
  if (opts.mpn) product.mpn = opts.mpn;
  if (opts.brand) product.brand = { "@type": "Brand", name: opts.brand };
  if (opts.sameAs && opts.sameAs.length > 0) product.sameAs = opts.sameAs;
  if (opts.rating && opts.rating.count > 0) {
    product.aggregateRating = {
      "@type": "AggregateRating",
      ratingValue: opts.rating.value,
      reviewCount: opts.rating.count,
      bestRating: 5,
      worstRating: 1,
    };
  }
  const reviews = (opts.reviews ?? []).filter((r) => r.author && r.rating > 0);
  if (reviews.length > 0) {
    product.review = reviews.map((r) => {
      const node: JsonLdNode = {
        "@type": "Review",
        reviewRating: { "@type": "Rating", ratingValue: r.rating, bestRating: 5, worstRating: 1 },
        author: { "@type": "Person", name: r.author },
      };
      if (r.title) node.name = r.title;
      if (r.body) node.reviewBody = r.body;
      if (r.date) node.datePublished = r.date.slice(0, 10);
      return node;
    });
  }
  if (opts.video && opts.video["@id"]) product.subjectOf = { "@id": opts.video["@id"] };

  const graph: JsonLdNode[] = [product, buildBreadcrumb(opts.breadcrumb, opts.url)];
  if (opts.video) graph.push(opts.video);
  const faqGraph = opts.faqs ? buildFaqGraph(opts.url, opts.faqs) : null;
  return mergeGraphs({ "@context": "https://schema.org", "@graph": graph }, faqGraph);
}

/**
 * FAQPage graph for a listing/detail page that carries admin-authored Q/A
 * (category pages, etc.). Answers are PLAIN TEXT (the caller strips any HTML) —
 * Google's FAQ rich result reads `acceptedAnswer.text` as text. Tied to the
 * page via `@id` so it composes alongside the CollectionPage graph. Returns null
 * when there are no entries (caller emits nothing — never an empty FAQPage).
 */
export function buildFaqGraph(
  url: string,
  faqs: Array<{ question: string; answer: string }>,
): JsonLdGraph | null {
  const entries = faqs
    .map((f) => ({ question: f.question.trim(), answer: f.answer.trim() }))
    .filter((f) => f.question.length > 0 && f.answer.length > 0);
  if (entries.length === 0) return null;
  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "FAQPage",
        "@id": `${url}#faq`,
        // Connect the FAQ to the page's CollectionPage node (`#webpage`, emitted
        // by buildCollectionGraph) so it isn't a graph orphan — matches the
        // entity-linkage discipline of the other builders. Google's FAQ parser
        // reads `mainEntity` regardless, so this is graph cohesion, not a fix.
        mainEntityOfPage: { "@id": `${url}#webpage` },
        mainEntity: entries.map((f) => ({
          "@type": "Question",
          name: f.question,
          acceptedAnswer: { "@type": "Answer", text: f.answer },
        })),
      },
    ],
  };
}

/**
 * Map a product video URL to the field Google's VideoObject spec expects: a PLAYER
 * URL under `embedUrl` for a known host (YouTube / Vimeo / Dailymotion), NOT the
 * watch/page URL Google rejects ("must be the URL of the video player itself; don't
 * link to the page on which the video lives"); otherwise `contentUrl` for a
 * directly-hosted media file. Admins paste watch URLs (youtube.com/watch, youtu.be,
 * shorts) or a direct .mp4 — mirror the storefront player's host handling.
 */
function videoUrlFields(url: string): { embedUrl: string } | { contentUrl: string } {
  const yt = url.match(
    /(?:youtube\.com\/(?:watch\?(?:[^#]*&)?v=|embed\/|shorts\/|v\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/i,
  );
  if (yt) return { embedUrl: `https://www.youtube.com/embed/${yt[1]}` };
  const vimeo = url.match(/vimeo\.com\/(?:video\/)?(\d+)/i);
  if (vimeo) return { embedUrl: `https://player.vimeo.com/video/${vimeo[1]}` };
  const dm = url.match(/(?:dailymotion\.com\/(?:embed\/)?video\/|dai\.ly\/)([A-Za-z0-9]+)/i);
  if (dm) return { embedUrl: `https://www.dailymotion.com/embed/video/${dm[1]}` };
  // Unknown host → treat as a direct media file (the admin pasted an .mp4 URL).
  return { contentUrl: url };
}

/**
 * VideoObject for a product that carries a video (PDP). Returns null unless BOTH a
 * URL AND a `thumbnailUrl` are present: name, thumbnailUrl and uploadDate are all
 * REQUIRED by Google's video rich result (a node missing any is reported as an
 * error and is ineligible), so a half-valid node is never shipped — the PDP's
 * thumbnail already falls back poster → OG → primary image, so this only skips a
 * product with literally no imagery. `embedUrl` (player) vs `contentUrl` (hosted
 * file) is chosen by host — never both. `uploadDate` is required by Google; the PDP
 * passes the product's publish/created date as a proxy. Linked FROM the Product via
 * `subjectOf: { @id }` so it isn't a graph orphan. `name` is capped at 110 chars.
 */
export function buildProductVideoLd(input: {
  id?: string | null;
  url: string | null | undefined;
  productName: string;
  uploadDate: string;
  title?: string | null;
  description?: string | null;
  thumbnailUrl?: string | null;
}): JsonLdNode | null {
  const url = input.url?.trim();
  const thumbnailUrl = input.thumbnailUrl?.trim();
  if (!url || !thumbnailUrl) return null;
  const name = (input.title?.trim() || `Vidéo — ${input.productName}`).slice(0, 110);
  return {
    "@type": "VideoObject",
    ...(input.id ? { "@id": input.id } : {}),
    name,
    description: input.description?.trim() || name,
    uploadDate: input.uploadDate,
    thumbnailUrl,
    ...videoUrlFields(url),
  };
}
