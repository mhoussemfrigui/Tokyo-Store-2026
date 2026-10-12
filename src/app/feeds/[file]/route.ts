import { NextResponse } from "next/server";

import { getFeedConfig } from "@/lib/seo/feeds/config";
import { loadFeedProducts } from "@/lib/seo/feeds/products";
import { buildGoogleMerchantFeed } from "@/lib/seo/feeds/google-merchant";
import { buildAcpFeed } from "@/lib/seo/feeds/acp-feed";
import type { FeedMeta } from "@/lib/seo/feeds/types";
import { resolvePublicOrigin } from "@/lib/url/public-origin";
import { getActiveCurrency } from "@/lib/currency/active";
import { getPriceDecimals } from "@/lib/price-format";
import { isSiteGatedForViewer } from "@/lib/site-mode/config";

/**
 * Product feeds at `/feeds/<editable-filename>` — one catch-all serving EITHER
 * the Google Merchant RSS (XML) OR the OpenAI ACP feed (JSON), selected by
 * matching the requested filename against the admin-configured + ENABLED paths
 * (SEO → Flux). A disabled or unknown filename → 404, so nothing leaks before
 * the admin opts in.
 *
 * ISR-cached (revalidate) — the whole catalogue is mapped once per window, NOT
 * per request, so a Googlebot / ChatGPT poll never hammers the DB. `noindex` +
 * absent from the sitemap (the feed is for ingestion, not search).
 */
export const revalidate = 1800; // 30 min — feeds are heavy + polled, not live

export async function GET(_req: Request, { params }: { params: Promise<{ file: string }> }) {
  // Maintenance / coming-soon ⇒ the store is closed: no feed (a pre-launch
  // catalogue must not reach Merchant Center / AI shopping agents). No staff
  // bypass — this ISR-cached file must never vary per viewer. Switching the mode
  // busts the ISR entry (saveSiteModeSettingsAction → revalidatePath("/", "layout")).
  if (await isSiteGatedForViewer({ allowStaff: false })) {
    return new NextResponse("Not found", {
      status: 404,
      headers: { "X-Robots-Tag": "noindex", "Cache-Control": "no-store" },
    });
  }

  const { file } = await params;
  const cfg = await getFeedConfig();
  const wantGoogle = cfg.google.enabled && file === cfg.google.path;
  const wantAcp = cfg.acp.enabled && file === cfg.acp.path;
  if (!wantGoogle && !wantAcp) {
    return new NextResponse("Not found", { status: 404, headers: { "X-Robots-Tag": "noindex" } });
  }

  const [origin, currency, priceDecimals] = await Promise.all([
    resolvePublicOrigin(),
    getActiveCurrency(),
    getPriceDecimals(),
  ]);
  const products = await loadFeedProducts(origin);

  const meta: FeedMeta = {
    feedTitle: `${cfg.sellerName} — produits`,
    feedLink: `${origin}/feeds/${file}`,
    feedDescription: `Flux produits ${cfg.sellerName}`,
    sellerName: cfg.sellerName,
    sellerUrl: cfg.sellerUrl,
    currency: currency.code,
    priceDecimals,
    storeCountry: cfg.storeCountry,
    targetCountries: cfg.targetCountries,
    returnPolicyUrl: cfg.returnPolicyUrl,
    privacyUrl: cfg.privacyUrl,
    tosUrl: cfg.tosUrl,
    builtAt: new Date().toUTCString(), // RFC-822 for RSS lastBuildDate
  };

  if (wantGoogle) {
    return new NextResponse(buildGoogleMerchantFeed(products, meta), {
      headers: {
        "Content-Type": "application/xml; charset=utf-8",
        "Cache-Control": "public, max-age=900, s-maxage=1800",
        "X-Robots-Tag": "noindex",
      },
    });
  }
  return new NextResponse(buildAcpFeed(products, meta), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "public, max-age=900, s-maxage=1800",
      "X-Robots-Tag": "noindex",
    },
  });
}
