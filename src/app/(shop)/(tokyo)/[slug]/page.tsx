import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { JsonLd } from "@/storefront/components/seo/json-ld";
import { CategoryView } from "@/storefront/components/storefront/category-view";
import { ProductView } from "@/storefront/components/storefront/product-view";
import { getCategoryBySlug, getCategoryLabel } from "@/storefront/lib/api/categories";
import {
  getProductBySlug,
  listAlsoViewed,
  listProductsByCategory,
  listProductsByIds,
} from "@/storefront/lib/api/products";
// Backend product facade (honours the admin's related_mode + curated manual lists —
// the storefront snapshot heuristic ignores them). Resolved to snapshot cards below.
import {
  listRelatedProducts as backendListRelated,
  listComplementaryProducts as backendListComplementary,
  getProductBySlug as getBackendProduct,
} from "@/lib/api/products";
import { getProductDetailBySlug } from "@/storefront/lib/api/product-detail";
import { getStorefrontShippingConfig } from "@/lib/checkout/shipping";
import { getSeoConfig } from "@/lib/seo/config";
import { buildPageMetadata, buildCmsPageMetadata } from "@/lib/seo/page-metadata";
import { buildCollectionGraph, buildProductGraph, buildProductVideoLd, mergeGraphs } from "@/lib/seo/jsonld";
import { canEmitAggregateRating, selectStructuredReviews } from "@/lib/seo/review-jsonld";
import { resolveOfferValidity } from "@/lib/seo/offer-validity";
import { getAllSettingsServerOnly, getMaisonExploreNav } from "@/lib/api/cms";
import { getSiteContacts, footerEntries } from "@/lib/cms/contact-list";
import { pageService } from "@/modules/cms/page/service";
import { mediaQueries } from "@/modules/media";
import {
  getCollectionPageConfig,
  isCollectionSlug,
  type CollectionPageConfig,
  type CollectionSlug,
} from "@/lib/pages/collection-page-config";
import { getCollectionShowcase } from "@/lib/pages/collection-data";
import {
  CollectionView,
  type CollectionCardExtra,
} from "@/storefront/components/storefront/collection/collection-view";
import { collectionCopy } from "@/storefront/lib/collection-copy";
import { getPageForRender, resolvePageBlocks } from "@/lib/pages/page-blocks-data";
import { InfoPageShell } from "@/storefront/components/storefront/info/info-page-shell";
import { InfoBlocks } from "@/storefront/components/storefront/info/info-blocks";
import { isInfoPage } from "@/storefront/components/storefront/info/info-registry";
import { deliveryQueries } from "@/modules/delivery/queries";
import { minorToDinars } from "@/lib/price";
import { getCurrentUser } from "@/lib/auth/session";
import { getReviewConfig, reviewService } from "@/modules/catalog/review";
import { listOrdersForUser } from "@/modules/order/queries";
import {
  categoryTrail,
  getNavContext,
  taxonomyLabel,
  universeCrumbs,
  type NavCrumb,
} from "@/storefront/lib/categoryNav";
import { getCategoryFaq, getCategoryMeta } from "@/storefront/lib/categorySeo";
import { getNavAlias } from "@/storefront/lib/navAliases";
import { conditionLabel, stockState } from "@/storefront/lib/productMeta";
import type { Product } from "@/storefront/types/catalog";

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";

/** Resolve a curated/ordered BACKEND product list to the storefront snapshot cards
 *  the rails render, preserving the backend order. Backend product id === card id. */
async function resolveCards(backend: { id?: string | null }[]): Promise<Product[]> {
  const ids = backend.map((b) => b.id).filter((id): id is string => Boolean(id));
  return ids.length > 0 ? listProductsByIds(ids) : [];
}

/** Absolutise a same-origin `/cdn` URL against the admin canonical origin for JSON-LD. */
function absUrl(origin: string, u: string | null | undefined): string | null {
  const s = (u ?? "").trim();
  if (!s) return null;
  return /^https?:\/\//i.test(s) ? s : `${origin}${s.startsWith("/") ? "" : "/"}${s}`;
}

/** Plain text from a lightly-marked-up description, for a JSON-LD `description`. */
function plainText(s: string | null | undefined, max = 400): string | undefined {
  const t = (s ?? "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!t) return undefined;
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

type Params = { params: Promise<{ slug: string }> };

type CmsPageRow = {
  title: string;
  meta_description: string | null;
};
type Resolved =
  | { kind: "collection"; slug: CollectionSlug; config: CollectionPageConfig }
  | { kind: "category"; slug: string; label: string; products: Product[] }
  | { kind: "product"; product: Product }
  | { kind: "page"; slug: string; page: CmsPageRow };

/**
 * Universal flat-slug resolver (mirrors the main platform's `[slug]` route,
 * simplified for the static catalog): a slug is a category (real or fuzzy) or a
 * product. Category resolution wins first, then product, then a fuzzy category
 * fallback for nav slugs that only match a product_type.
 */
async function resolveSlug(slug: string): Promise<Resolved | null> {
  /* Admin-managed showcase collections (Vitrines) — Nouveautés / Top ventes /
     Promotions. Checked FIRST so the backend config (strategy, pins, SEO,
     visibility) owns these slugs instead of the static nav-alias heuristic.
     A collection hidden in admin (`visible: false`) resolves to null → 404,
     making the admin visibility toggle authoritative over the live page. */
  if (isCollectionSlug(slug)) {
    const config = await getCollectionPageConfig(slug).catch(() => null);
    if (!config || !config.visible) return null;
    return { kind: "collection", slug, config };
  }

  /* Nav destinations that are not catalogue categories — Bons plans, Notre
     sélection, Gift Cards. They are checked first so they always
     win, and they render through CategoryView like any category. */
  const alias = getNavAlias(slug);
  if (alias) {
    return { kind: "category", slug, label: alias.label, products: await alias.resolve() };
  }

  /* Real categories are labelled with the taxonomy's spelling when it has
     one, so the h1, the metadata and the JSON-LD all read the same. */
  const category = await getCategoryBySlug(slug);
  if (category) {
    const [products, label] = await Promise.all([
      listProductsByCategory(slug),
      getCategoryLabel(slug),
    ]);
    return { kind: "category", slug, label: taxonomyLabel(slug) ?? label, products };
  }

  const product = await getProductBySlug(slug);
  if (product) return { kind: "product", product };

  const fuzzy = await listProductsByCategory(slug);
  if (fuzzy.length > 0) {
    const label = taxonomyLabel(slug) ?? (await getCategoryLabel(slug));
    return { kind: "category", slug, label, products: fuzzy };
  }

  /* Editable CMS pages (Contenu & Design → Pages) — the info/system pages
     (apropos, aide, cgv…) and any published custom page. Resolved LAST so a
     product / category slug always wins; rendered as crimson blocks. */
  const cmsPage = await pageService.findBySlug(slug).catch(() => null);
  if (cmsPage && cmsPage.is_published) {
    return {
      kind: "page",
      slug,
      page: { title: cmsPage.title, meta_description: cmsPage.meta_description },
    };
  }

  return null;
}

/* Story tiles and crumbs must never lead to a 404: the taxonomy lists shelves
   the catalogue does not carry yet. Same order as resolveSlug, listings only. */
async function isListing(slug: string): Promise<boolean> {
  if (getNavAlias(slug) || (await getCategoryBySlug(slug))) return true;
  return (await listProductsByCategory(slug)).length > 0;
}
async function onlyListings(list: NavCrumb[]): Promise<NavCrumb[]> {
  const ok = await Promise.all(list.map((c) => isListing(c.slug)));
  return list.filter((_, i) => ok[i]);
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { slug } = await params;
  const resolved = await resolveSlug(slug);
  if (!resolved) return { title: "Page introuvable" };

  if (resolved.kind === "page") {
    // Full CMS-page SEO (meta title/description, médiathèque OG image, canonical
    // override, noindex) via the shared helper that EVERY CMS-page route uses —
    // it re-reads the page row, primes the CDN base before resolving the OG URL,
    // and applies the soft-404 noindex. (Previously this branch hand-rolled the
    // resolution without priming — M-07 cleanup.)
    return buildCmsPageMetadata(resolved.slug, {
      title: resolved.page.title,
      description: resolved.page.meta_description ?? "",
    });
  }

  if (resolved.kind === "collection") {
    // Admin-managed SEO (Contenu & Design → Vitrines): the meta title/description
    // and the per-collection noindex now actually drive the rendered <head>
    // (they used to be dead config — read only by the sitemap/llms/.md twin).
    const { metaTitle, metaDescription, noindex } = resolved.config.seo;
    return {
      // `absolute` so the root title.template ("%s · Tokyo Store") is NOT applied
      // on top — the default metaTitle already carries the brand ("Top ventes —
      // Tokyo Store"), so a plain string would double-brand (same reason the
      // product branch uses buildPageMetadata's absolute title).
      title: { absolute: metaTitle },
      description: metaDescription,
      alternates: { canonical: `/${resolved.slug}` },
      ...(noindex ? { robots: { index: false, follow: true } } : {}),
      openGraph: { title: metaTitle, description: metaDescription, url: `/${resolved.slug}`, type: "website" },
    };
  }

  if (resolved.kind === "category") {
    // A nav alias writes its own (a pre-order does not ship in 24h, a gift
    // card is a code sent by e-mail); real categories use the template.
    const { title, description } = getCategoryMeta(resolved.label);
    return {
      title,
      description,
      alternates: { canonical: `/${resolved.slug}` },
      openGraph: { title, description, url: `/${resolved.slug}`, type: "website" },
    };
  }

  const p = resolved.product;
  // Live backend row (`"use cache"`, so this is near-free and reused by the page
  // body) — carries the admin SEO overrides the snapshot card doesn't: canonical,
  // noindex, OG image. generateMetadata honours them so admin edits take effect
  // immediately (no re-export), matching the PDP's live-detail philosophy.
  const bp = await getBackendProduct(p.slug).catch(() => null);
  const cond = conditionLabel(p.condition);
  // Admin meta title → computed template (NO brand suffix — buildPageMetadata strips
  // any baked-in brand and applies the title template exactly once, fixing the
  // double-brand defect the inline block had).
  const metaTitle = (bp?.metaTitle ?? p.metaTitle ?? "").trim();
  const title = metaTitle || `${p.title} — ${cond} au meilleur prix en Tunisie`;
  // Backend-only description: admin meta description → the product's own short
  // description → (buildPageMetadata falls back to the admin default). No fabricated
  // delivery/store-name copy.
  const description =
    (bp?.metaDescription ?? p.metaDescription ?? "").trim() || plainText(bp?.shortDesc, 300) || undefined;
  const base = await buildPageMetadata({
    title,
    description,
    path: `/${p.slug}`,
    // Honour the admin per-product noindex (was ignored on the product branch).
    index: bp?.noindex ? false : undefined,
    // Admin OG-image override (SEO tab) → social card; else the primary image.
    image: bp?.ogImage ?? p.image,
  });
  // Admin canonical override (variant/duplicate → master) wins over the default /slug.
  const canonical = bp?.canonicalUrl?.trim();
  return canonical ? { ...base, alternates: { ...base.alternates, canonical } } : base;
}

export default async function SlugPage({ params }: Params) {
  const { slug } = await params;
  const resolved = await resolveSlug(slug);
  if (!resolved) notFound();

  if (resolved.kind === "page") {
    const forRender = await getPageForRender(resolved.slug).catch(() => null);
    if (!forRender) notFound();
    const [resolvedPage, settings] = await Promise.all([
      resolvePageBlocks(forRender),
      getAllSettingsServerOnly().catch(() => ({}) as Record<string, string | null>),
    ]);
    const contacts = getSiteContacts(settings);
    const phone = footerEntries(contacts.phones)[0]?.value ?? settings["site.contact_phone"] ?? null;
    const title = forRender.page.title;
    const lede = forRender.page.metaDescription;
    if (isInfoPage(resolved.slug)) {
      // The « Explorer la maison » index (CMS maison-explore menu) at the foot —
      // previously resolved by no caller, so the control was dead.
      const maisonExplore = await getMaisonExploreNav().catch(() => null);
      return (
        <InfoPageShell slug={resolved.slug} title={title} lede={lede} phone={phone} maisonExplore={maisonExplore}>
          <InfoBlocks resolved={resolvedPage} />
        </InfoPageShell>
      );
    }
    return (
      <div className="page-container flex flex-col gap-5 pt-3">
        <InfoBlocks resolved={resolvedPage} />
      </div>
    );
  }

  if (resolved.kind === "collection") {
    const { config } = resolved;
    const copy = collectionCopy(resolved.slug);
    const [data, settings, seo] = await Promise.all([
      getCollectionShowcase(config, copy.windows ?? []),
      getAllSettingsServerOnly().catch(() => ({}) as Record<string, string | null>),
      getSeoConfig().catch(() => null),
    ]);
    // Backend selection (pins + strategy) → the snapshot cards the rest of the
    // store renders (prices/stock stay consistent site-wide), order preserved.
    const cards = await resolveCards(data.products);

    // Per-card backend stats, aligned to the cards that resolved to a snapshot:
    // sales-per-window (Top ventes) / days-since-arrival (Nouveautés).
    const extrasById: Record<string, CollectionCardExtra> = {};
    for (const c of cards) {
      const extra: CollectionCardExtra = {};
      if (data.salesById?.[c.id]) extra.sales = data.salesById[c.id];
      if (data.daysById && c.id in data.daysById) extra.days = data.daysById[c.id];
      const promo = data.promoById?.[c.id];
      if (promo) {
        extra.price = promo.price;
        extra.oldPrice = promo.oldPrice;
      }
      if (extra.sales || "days" in extra || promo) extrasById[c.id] = extra;
    }

    // Real backend contact phone for the FAQ "une autre question ?" CTA (same
    // source as the footer) — never hardcoded.
    const contacts = getSiteContacts(settings);
    const phone = footerEntries(contacts.phones)[0]?.value ?? settings["site.contact_phone"] ?? null;
    const catDesc = config.subtitle.trim() || copy.catDesc;
    // Vitrines hero image (médiathèque id → content URL) — previously a dead control.
    const heroImage = await mediaQueries.resolveUrlById(config.heroMediaId).catch(() => null);

    // Structured data: CollectionPage + ItemList + Breadcrumb (+ FAQPage) through
    // the tested SEO builders — the admin config now owns the collection graph
    // (was generic category JSON-LD for /nouveautes, and nothing at all for the
    // two slugs that used to 404).
    const origin = (seo?.siteUrl ?? SITE_URL).replace(/\/$/, "");
    const url = `${origin}/${resolved.slug}`;
    const jsonLd = seo
      ? mergeGraphs(
          buildCollectionGraph(seo, {
            url,
            name: config.title,
            description: config.seo.metaDescription,
            breadcrumb: [
              { name: "Accueil", url: `${origin}/` },
              { name: config.title, url },
            ],
            productUrls: cards.map((c) => `${origin}/${c.slug}`),
            totalItems: cards.length,
          }),
          {
            "@context": "https://schema.org",
            "@graph": [
              {
                "@type": "FAQPage",
                "@id": `${url}#faq`,
                mainEntity: copy.faqs.map((f) => ({
                  "@type": "Question",
                  name: f.q,
                  acceptedAnswer: { "@type": "Answer", text: f.a },
                })),
              },
            ],
          },
        )
      : null;

    return (
      <>
        {jsonLd && <JsonLd data={jsonLd} />}
        <CollectionView
          key={resolved.slug}
          slug={resolved.slug}
          strategy={config.strategy}
          title={config.title}
          eyebrow={config.eyebrow}
          catDesc={catDesc}
          ctaLabel={config.ctaLabel}
          ctaHref={config.ctaHref}
          heroImage={heroImage}
          defaultSort={config.defaultSort}
          products={cards}
          extrasById={extrasById}
          empty={config.empty}
          showClosingCta={config.showClosingCta}
          ctaBand={config.ctaBand}
          navBar={config.navBar}
          phone={phone}
        />
      </>
    );
  }

  if (resolved.kind === "category") {
    const ctx = getNavContext(resolved.slug);
    const siblings = ctx.siblings;
    const [subNav, liveTrail] = await Promise.all([
      onlyListings(siblings.length > 0 ? siblings : universeCrumbs),
      onlyListings(categoryTrail(resolved.slug)),
    ]);
    // Per-pill product counts for the sub-category rail (the "Tout {universe}"
    // pill + each sibling). Cheap in-memory counts over the static snapshot.
    const countSlugs = [
      ...(ctx.universe ? [ctx.universe.slug] : []),
      ...subNav.map((c) => c.slug),
    ];
    const subNavCounts = Object.fromEntries(
      await Promise.all(
        countSlugs.map(async (s) => [
          s,
          await listProductsByCategory(s)
            .then((ps) => ps.length)
            .catch(() => 0),
        ] as const),
      ),
    );
    const faq = getCategoryFaq(resolved.label);
    // Mirrors the visible trail: Accueil › universe › section › this page, with
    // the alias spelling ("Gift Cards", not the taxonomy's "Gift-Cards").
    const trail = [
      { name: "Accueil", path: "/" },
      ...liveTrail.map((c) => ({
        name: getNavAlias(c.slug)?.label ?? c.label,
        path: `/${c.slug}`,
      })),
      { name: resolved.label, path: `/${resolved.slug}` },
    ];
    const breadcrumbLd = {
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: trail.map((c, i) => ({
        "@type": "ListItem",
        position: i + 1,
        name: c.name,
        item: `${SITE_URL}${c.path}`,
      })),
    };
    const faqLd = {
      "@context": "https://schema.org",
      "@type": "FAQPage",
      mainEntity: faq.map((f) => ({
        "@type": "Question",
        name: f.q,
        acceptedAnswer: { "@type": "Answer", text: f.a },
      })),
    };
    return (
      <>
        <JsonLd data={[breadcrumbLd, faqLd]} />
        <CategoryView
          key={resolved.slug}
          slug={resolved.slug}
          label={resolved.label}
          products={resolved.products}
          subNav={subNav}
          trail={liveTrail}
          subNavCounts={subNavCounts}
        />
      </>
    );
  }

  const card = resolved.product;
  const user = await getCurrentUser();
  const [related, complementary, alsoViewed, detail, settings, pickupRows, carrierRows, reviewConfig, existingReview, recentOrders, shippingConfig] =
    await Promise.all([
      // « Produits similaires » — honours the admin's related_mode + curated
      // product_related (backend), then resolves to snapshot cards for the rail.
      backendListRelated(card.slug, 8).then(resolveCards).catch(() => []),
      // « Complétez votre achat » — curated complementary accessories (backend);
      // empty when the admin picked none (no auto fallback). Resolved to cards.
      backendListComplementary(card.slug, 8).then(resolveCards).catch(() => []),
      listAlsoViewed(card.slug),
      // LIVE backend detail (gallery, description, characteristics, variants, video,
      // FAQ, SEO overrides) for the ONE product being viewed — keeps the client
      // snapshot card-sized while the PDP shows real-time backend data. Graceful: {}.
      getProductDetailBySlug(card.slug),
      getAllSettingsServerOnly().catch(() => ({}) as Record<string, string | null>),
      // Store-pickup points + home-delivery carrier, from the delivery backend the
      // operator manages at Commandes → Livraison. Graceful: [] when unavailable.
      deliveryQueries.listEnabledPickups("in_store").catch(() => []),
      deliveryQueries.listEnabledAgents().catch(() => []),
      // Review policy + the viewer's existing review (for the write-form gating), and
      // their most recent order (to pre-fill « Achat rapide »). All session-gated.
      getReviewConfig().catch(() => null),
      user ? reviewService.findByUserAndProduct(user.id, card.id).catch(() => null) : Promise.resolve(null),
      user ? listOrdersForUser(user.id, { limit: 1 }).catch(() => []) : Promise.resolve([]),
      // National home-delivery flat rate (Système → Checkout) → the Offer's
      // OfferShippingDetails, so the merchant listing carries the real shipping fee.
      getStorefrontShippingConfig().catch(() => null),
    ]);
  // Snapshot card (care, category_path, product_type, rating) + live detail overlay.
  // Review list/summary are passed as their own props (not part of Product).
  const { reviewItems, reviewSummary, ...detailCore } = detail;
  const p: Product = { ...card, ...detailCore };

  // Boutiques (« Retrait en boutique ») + contact phone — backend-wired, same source
  // as the footer. No display-flagged addresses → the section + pickup row stay hidden
  // (keeps the "no fake stores" rule). Addresses are free-text; each is one boutique.
  const contacts = getSiteContacts(settings);
  const phone = footerEntries(contacts.phones)[0]?.value ?? settings["site.contact_phone"] ?? null;

  // Delivery backend → PDP « Retrait & livraison »: physical in-store pickup points
  // + the nationwide home-delivery carrier(s). Fees are converted to dinars for display.
  const pickups = pickupRows.map((p) => ({
    id: p.id,
    name: p.name,
    address: [p.address_line, p.city].filter(Boolean).join(", ") || null,
    phone: p.phone ?? phone,
    hours: p.hours_label,
    fee: minorToDinars(p.fee_cents),
  }));
  const carriers = carrierRows.map((a) => ({
    id: a.id,
    name: a.name,
    zone: a.zone_label,
    fee: a.fee_cents != null ? minorToDinars(a.fee_cents) : null,
  }));

  // Reviews write-form gating + « Achat rapide » prefill, both from the session.
  const reviewAuth = {
    enabled: reviewConfig?.enabled ?? true,
    signedIn: !!user,
    alreadyReviewed: !!existingReview && existingReview.status !== "rejected",
    previouslyRejected: existingReview?.status === "rejected",
    policy: reviewConfig?.policy ?? ("all" as const),
    requireApproval: reviewConfig?.requireApproval ?? true,
  };
  const lastOrder = recentOrders[0];
  const prefill = user
    ? {
        name: (lastOrder?.ship_full_name || user.name || "").trim() || undefined,
        phone: (lastOrder?.ship_phone || lastOrder?.contact_phone || "").trim() || undefined,
        address:
          [lastOrder?.ship_street_line1, lastOrder?.ship_street_line2].filter(Boolean).join(", ").trim() ||
          undefined,
        city: (lastOrder?.ship_region || "").trim() || undefined,
      }
    : null;

  // ── Structured data (schema.org) — built from the SAME admin SEO config origin
  //    the canonical uses (not the build-time SITE_URL), through the tested SEO
  //    builders. Product + Breadcrumb + (VideoObject) + (FAQPage) in one @graph. ──
  const seo = await getSeoConfig().catch(() => null);
  const origin = (seo?.siteUrl ?? SITE_URL).replace(/\/$/, "");
  const url = `${origin}/${p.slug}`;

  // AggregateRating + Review[] ONLY past the ≥5 public-review threshold (never a
  // thin/fabricated rating); reviews filtered to the store's rating-source policy.
  const publicCount = reviewSummary?.count ?? 0;
  const ratingEligible = canEmitAggregateRating(reviewAuth.enabled, publicCount);
  const rating =
    ratingEligible && reviewSummary && reviewSummary.average > 0
      ? { value: Number(reviewSummary.average.toFixed(1)), count: reviewSummary.count }
      : null;
  const ratingSource = reviewConfig?.ratingSource ?? "all";
  const structuredReviews = ratingEligible
    ? selectStructuredReviews(
        (reviewItems ?? []).map((r) => ({ authorName: r.author, rating: r.rating, source: r.source, item: r })),
        ratingSource,
      )
        .slice(0, 10)
        .map((x) => ({
          author: x.item.author,
          rating: x.item.rating,
          title: x.item.title,
          body: plainText(x.item.body, 500) ?? null,
          date: x.item.date,
        }))
    : [];

  // itemCondition from the RAW backend condition (used → UsedCondition, not Refurbished).
  const rawCond = (p.condition || "new").toLowerCase();
  const itemCondition =
    rawCond === "new"
      ? "https://schema.org/NewCondition"
      : rawCond === "refurbished"
        ? "https://schema.org/RefurbishedCondition"
        : "https://schema.org/UsedCondition";

  // Rolling price-validity window (Google warns on an Offer with no priceValidUntil).
  const offerValidity = resolveOfferValidity({
    nowMs: Date.now(),
    createdAtMs: p.publishedAt ? new Date(p.publishedAt).getTime() : Date.now(),
    promoStartsAtMs: null,
    promoEndsAtMs: null,
  });

  // Real national shipping fee → OfferShippingDetails: the global flat rate (Système →
  // Checkout) is the true delivery charge; fall back to the cheapest carrier's explicit
  // fee, else omit (never fabricated). A 0 fee is valid (free national delivery).
  const carrierFees = carriers.map((c) => c.fee).filter((n): n is number => n != null);
  const shipFee =
    shippingConfig && Number.isFinite(shippingConfig.fee)
      ? shippingConfig.fee
      : carrierFees.length > 0
        ? Math.min(...carrierFees)
        : null;
  const shippingRate = shipFee != null ? { value: shipFee, currency: "TND" } : null;

  // Breadcrumb mirrors the visible trail (Accueil › … › leaf), absolute URLs.
  const leafLabel = p.category ? (taxonomyLabel(p.category) ?? (await getCategoryLabel(p.category))) : "";
  const breadcrumb = [
    { name: "Accueil", url: `${origin}/` },
    ...categoryTrail(p.category).map((c) => ({
      name: getNavAlias(c.slug)?.label ?? c.label,
      url: `${origin}/${c.slug}`,
    })),
    ...(p.category && leafLabel ? [{ name: leafLabel, url }] : []),
  ];

  // VideoObject (null unless the product has a video + a thumbnail).
  const videoLd = buildProductVideoLd({
    id: `${url}#video`,
    url: p.videoUrl,
    productName: p.title,
    uploadDate: (p.publishedAt ?? new Date().toISOString()).slice(0, 10),
    title: p.videoTitle,
    description: p.videoDescription,
    thumbnailUrl: absUrl(origin, p.videoPoster || p.ogImage || p.image),
  });

  // Gallery → absolute image URLs; backend FAQ → FAQPage (none ⇒ omitted, no fallback).
  const images = (p.images && p.images.length > 0 ? p.images : [p.image])
    .map((u) => absUrl(origin, u))
    .filter((u): u is string => Boolean(u));
  const faqEntries = (p.faq ?? []).map((f) => ({ question: f.q, answer: f.a }));

  const productGraph = seo
    ? buildProductGraph(seo, {
        url,
        name: p.title,
        description: plainText(p.shortDesc || p.description),
        images,
        sku: p.sku ?? null,
        gtin: p.gtin ?? null,
        mpn: p.mpn ?? null,
        brand: p.brand || null,
        // sameAs gated on the global per-product switch (seo.product_sameas_enabled).
        sameAs: seo.productSameAsEnabled ? (p.sameAs ?? []) : [],
        rating,
        reviews: structuredReviews,
        offer: {
          price: p.price,
          currency: "TND",
          // Tokyo's "backorder" state is PRÉCOMMANDE — a not-yet-released product
          // on preorder — so it maps to schema.org/PreOrder (not BackOrder, which
          // means released-but-temporarily-OOS), with the release date as
          // `availabilityStarts` when known.
          availability: {
            in_stock: "https://schema.org/InStock",
            backorder: "https://schema.org/PreOrder",
            out_of_stock: "https://schema.org/OutOfStock",
          }[stockState(p)],
          availabilityStarts: p.preorderReleasesAt ?? undefined,
          itemCondition,
          validFrom: offerValidity.validFrom,
          priceValidUntil: offerValidity.priceValidUntil,
          shippingRate,
        },
        breadcrumb,
        video: videoLd,
        faqs: faqEntries.length > 0 ? faqEntries : undefined,
      })
    : null;

  return (
    <>
      {productGraph && <JsonLd data={productGraph} />}
      <ProductView
        key={p.id}
        product={p}
        related={related}
        alsoViewed={alsoViewed}
        complementary={complementary}
        phone={phone}
        pickups={pickups}
        carriers={carriers}
        reviews={reviewItems}
        reviewSummary={reviewSummary}
        reviewAuth={reviewAuth}
        prefill={prefill}
      />
    </>
  );
}
