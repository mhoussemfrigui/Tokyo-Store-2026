import { getSeoConfig, DEFAULT_SITE_NAME } from "@/lib/seo/config";
import { getSettingsMap } from "@/modules/cms/setting/queries";
import { listApiCategories } from "@/lib/api/categories";
import { listApiBlogCategories } from "@/lib/api/blog";
import { getCheckoutCopy } from "@/lib/checkout/copy";
import { getDefaultWarranty } from "@/lib/warranty";
import { getActiveCurrency } from "@/lib/currency/active";
import { getPriceDecimals } from "@/lib/price-format";
import { getFeedConfig } from "@/lib/seo/feeds/config";
import { COLLECTION_SLUGS, COLLECTION_PAGE_LABELS } from "@/lib/pages/collection-slugs";
import { getCollectionPageConfig } from "@/lib/pages/collection-page-config";
import { resolvePublicOrigin } from "@/lib/url/public-origin";
import { buildLlmsTxt, buildCategoryForest, type LlmsLink } from "@/lib/seo/llms-txt";
import { getSiteModeConfig } from "@/lib/site-mode/config";
import { isSiteGated } from "@/lib/site-mode/parse";

// Regenerated per request so it always reflects the live catalog + settings.
export const dynamic = "force-dynamic";

/**
 * /llms.txt — a rich, AI-crawler-friendly map of the store (the emerging llms.txt
 * convention, tuned for 2026 AEO/GEO). The admin can override the whole body from
 * the SEO panel (seo.llms_txt); otherwise it is GENERATED from the live catalog +
 * settings, so adding a category / blog topic / feed auto-updates it. The pure
 * shape lives in src/lib/seo/llms-txt.ts (unit-tested); this route only gathers.
 */
export async function GET() {
  const seo = await getSeoConfig().catch(() => null);
  const headers = {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "public, max-age=300, s-maxage=900",
  } as const;

  // Maintenance / coming-soon ⇒ a MINIMAL body (site name + the public gate
  // copy the MaintenanceScene already shows) — never the category tree / feed
  // links of a closed (esp. pre-launch) store. Checked BEFORE the admin override,
  // which may itself describe the catalogue. No staff bypass (cookie-free file);
  // fails OPEN (settings error ⇒ live). `no-store` so re-opening shows at once.
  const siteMode = await getSiteModeConfig();
  if (isSiteGated(siteMode.mode)) {
    const name = seo?.siteName ?? DEFAULT_SITE_NAME;
    const notice = `${siteMode.title} — ${siteMode.message}`.replace(/\s+/g, " ").trim();
    return new Response(`# ${name}\n\n> ${notice}\n`, {
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
    });
  }

  // Full admin override wins verbatim.
  if (seo?.llmsTxt && seo.llmsTxt.trim().length > 0) {
    return new Response(seo.llmsTxt, { headers });
  }

  // ONE origin source of truth (seo.site_url ▸ NEXT_PUBLIC_SITE_URL ▸ localhost),
  // shared with the sitemap / robots / emails so machine surfaces never disagree.
  const origin = await resolvePublicOrigin();

  const [map, apiCategories, blogCats, copy, warranty, currency, decimals, feeds, collectionConfigs] =
    await Promise.all([
      getSettingsMap().catch(() => ({}) as Record<string, string | null>),
      listApiCategories({ activeOnly: true }).catch(() => []),
      listApiBlogCategories().catch(() => []),
      getCheckoutCopy().catch(() => null),
      getDefaultWarranty().catch(() => ({ months: 0, label: null as string | null })),
      getActiveCurrency().catch(() => ({ code: "TND" })),
      getPriceDecimals().catch(() => 0),
      getFeedConfig().catch(() => null),
      Promise.all(COLLECTION_SLUGS.map((s) => getCollectionPageConfig(s).catch(() => null))),
    ]);

  const clean = (v: string | null | undefined) => {
    const t = (v ?? "").trim();
    return t.length ? t : null;
  };

  // Smart collections + the brands index — the high-value landing pages. A
  // collection hidden or noindexed by the admin is dropped (mirrors the sitemap),
  // so llms.txt never advertises a page the store keeps out of search.
  const keyPages: LlmsLink[] = [
    ...COLLECTION_SLUGS.flatMap((s, i) => {
      const cfg = collectionConfigs[i];
      return cfg && cfg.visible && !cfg.seo.noindex ? [{ name: COLLECTION_PAGE_LABELS[s], path: `/${s}` }] : [];
    }),
    { name: "Toutes les marques", path: "/marques" },
  ];

  // Shipping facts — configured values only (no fabricated claims; money = millimes).
  const fmtMajor = (cents: number) => (cents / 1000).toFixed(decimals);
  let deliveryDays: string | null = null;
  if (
    copy &&
    copy.handlingDaysMin != null &&
    copy.handlingDaysMax != null &&
    copy.transitDaysMin != null &&
    copy.transitDaysMax != null
  ) {
    const min = copy.handlingDaysMin + copy.transitDaysMin;
    const max = copy.handlingDaysMax + copy.transitDaysMax;
    deliveryDays =
      min === max ? `${min} jour${min > 1 ? "s" : ""} ouvrable${min > 1 ? "s" : ""}` : `${min} à ${max} jours ouvrables`;
  }
  const shipping = copy
    ? {
        currency: currency.code,
        feeMajor: copy.defaultFeeCents != null ? fmtMajor(copy.defaultFeeCents) : null,
        freeThresholdMajor: copy.freeThresholdCents != null ? fmtMajor(copy.freeThresholdCents) : null,
        freeEnabled: copy.freeShippingEnabled,
        deliveryDays,
      }
    : null;

  // Enabled machine feeds (absolute URLs — the Ressources section emits them as-is).
  const feedLinks: LlmsLink[] = [];
  if (feeds?.google.enabled)
    feedLinks.push({ name: "Flux Google Merchant", path: `${origin}/feeds/${feeds.google.path}` });
  if (feeds?.acp.enabled)
    feedLinks.push({ name: "Flux IA (Agentic Commerce)", path: `${origin}/feeds/${feeds.acp.path}` });

  const body = buildLlmsTxt({
    siteName: seo?.siteName ?? DEFAULT_SITE_NAME,
    origin,
    tagline: clean(map["site.tagline"]),
    description: seo?.defaultDescription ?? `Boutique high-tech ${seo?.siteName ?? DEFAULT_SITE_NAME} en Tunisie.`,
    knowsAbout: seo?.knowsAbout ?? [],
    categories: buildCategoryForest(
      apiCategories.map((c) => ({
        id: c.id,
        slug: c.slug,
        name: c.name,
        parentId: c.parentId,
        tagline: c.tagline,
        description: c.description,
        displayOrder: c.displayOrder,
        noindex: c.noindex,
      })),
    ),
    keyPages,
    blogCategories: blogCats.map((c) => ({ name: c.name, path: `/blog/${c.slug}` })),
    contact: {
      email: seo?.contactEmail ?? null,
      phone: seo?.contactPhone ?? null,
      address: seo?.address ?? null,
      whatsapp: clean(map["site.whatsapp"]),
      hours: clean(map["site.hours"]),
    },
    social: seo?.sameAs ?? [],
    shipping,
    warranty: { months: warranty.months ?? 0, label: warranty.label },
    business: { legalName: clean(map["business.legal_name"]), taxId: clean(map["business.tax_id"]) },
    feeds: feedLinks,
  });

  return new Response(body, { headers });
}
