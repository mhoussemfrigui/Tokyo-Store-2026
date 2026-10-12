import { NextResponse } from "next/server";

import { isMarkdownAgentsEnabled } from "@/lib/seo/markdown/config";
import { resolveMarkdownForPath } from "@/lib/seo/markdown/generate";
import { isSiteGatedForViewer } from "@/lib/site-mode/config";
import { getCurrentUser } from "@/lib/auth/session";
import { resolvePublicOrigin } from "@/lib/url/public-origin";
import { getActiveCurrency } from "@/lib/currency/active";
import { getPriceDecimals } from "@/lib/price-format";

/**
 * "Markdown for Agents" generation endpoint. The edge proxy (proxy.ts) rewrites
 * a markdown-shaped request (`Accept: text/markdown` or a `.md` suffix) here; this
 * node route reads the DB toggle, generates the Markdown from the SAME data layer
 * the pages use (never scrapes HTML), and returns it with the agent + anti-index
 * headers. Humans (Accept: text/html) are never routed here.
 *
 * `force-dynamic`: the served path comes from a catch-all + the request, and the
 * body reflects live content. A CDN-level `s-maxage` keeps the DB load bounded
 * without per-request prerendering.
 */
export const dynamic = "force-dynamic";

// Every markdown response (success OR 404) carries these: never index the twin,
// and Vary on Accept since the SAME storefront URL serves HTML or Markdown by
// content negotiation (so a shared cache keys the two variants apart).
const ERROR_HEADERS = { "X-Robots-Tag": "noindex", Vary: "Accept" } as const;

export async function GET(_req: Request, { params }: { params: Promise<{ path: string[] }> }) {
  if (!(await isMarkdownAgentsEnabled())) {
    return new NextResponse("Not found", { status: 404, headers: ERROR_HEADERS });
  }

  // Honor the site-availability gate (maintenance / coming_soon). The HTML gate
  // lives only in (shop)/layout.tsx, but /md is a SEPARATE route tree that
  // rebuilds the same content (product name/description/price) from the data
  // layer — so without this a gated (esp. pre-launch coming_soon) store leaks its
  // whole catalog to any client sending `Accept: text/markdown` / a `.md` URL.
  // Fail-open (a settings error ⇒ live) + staff bypass, mirroring the layout
  // gate — the shared helper every non-page public surface uses.
  if (await isSiteGatedForViewer()) {
    return new NextResponse("Not found", { status: 404, headers: ERROR_HEADERS });
  }

  const { path } = await params;
  const rawPath = `/${(path ?? []).join("/")}`;

  const [origin, currency, priceDecimals] = await Promise.all([
    resolvePublicOrigin(),
    getActiveCurrency(),
    getPriceDecimals(),
  ]);

  const result = await resolveMarkdownForPath(rawPath, {
    origin,
    currency: currency.code,
    priceDecimals,
  }).catch(() => null);

  if (!result) {
    return new NextResponse("Not found", { status: 404, headers: ERROR_HEADERS });
  }

  // A SIGNED-IN viewer's body may be per-viewer (personalised pricing / session
  // state), so it must never land in a shared cache and be replayed to guests —
  // `private, no-store`, same rule as /api/store/search. Anonymous bodies are
  // the public-only set (safe to share on the CDN).
  const signedIn = await getCurrentUser().catch(() => null);
  return new NextResponse(result.markdown, {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      Vary: "Accept",
      "x-markdown-tokens": String(result.tokens),
      // Never index the markdown twin; always point crawlers at the real HTML
      // page's canonical (override-aware, flat for sub-categories) — the SAME
      // URL the HTML page declares, never the raw requested path.
      "X-Robots-Tag": "noindex",
      Link: `<${result.canonicalUrl}>; rel="canonical"`,
      "Cache-Control": signedIn ? "private, no-store" : "public, max-age=300, s-maxage=900",
    },
  });
}
