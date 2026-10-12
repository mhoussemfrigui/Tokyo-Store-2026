/**
 * PURE robots.txt body builder. No DB / no I/O — the route handler
 * (src/app/robots.txt/route.ts) gathers config and calls this. Unit-testable.
 *
 * 2026 stance: WELCOME search + AI assistants to PUBLIC content (that is the whole
 * point of the Markdown twins + the ACP product feed) while blocking the private
 * app areas for EVERYONE via a single `*` group. We deliberately do NOT emit
 * per-bot groups: in robots.txt a crawler obeys ONLY its most-specific matching
 * User-agent group, so a naive `User-agent: GPTBot\nAllow: /` would make that bot
 * ignore `*` and crawl /admin. One correct `*` group is simpler AND safer; the
 * llms.txt pointer + the lack of an AI-bot block is the welcome signal.
 *
 * Reactivity: the product-feed `Allow:` carve-outs and the `/md` Disallow appear
 * ONLY while the corresponding feature is enabled (SEO → Flux / Markdown agents),
 * so robots.txt always matches what is actually being served.
 */

export type RobotsInput = {
  /** Absolute origin, no trailing slash. */
  origin: string;
  siteName: string;
  /** seo.robots_index master switch — false ⇒ discourage ALL indexing. */
  indexable: boolean;
  /** Admin-added site-root Disallow paths (already validated by getSeoConfig). */
  extraDisallow: string[];
  feeds: {
    google: { enabled: boolean; path: string };
    acp: { enabled: boolean; path: string };
  };
  /** seo.markdown_agents_enabled — gates the /md noindex-twin Disallow lines. */
  markdownEnabled: boolean;
  /**
   * The storefront is CLOSED (site.mode maintenance / coming_soon) ⇒ suspend
   * ALL crawling (`Disallow: /`) and advertise no sitemap (it is empty while
   * gated). Wins over every other input. Optional — omitted ⇒ open.
   */
  siteClosed?: boolean;
};

/** Private app areas blocked for every crawler (never useful/indexable).
 *  `/checkout` completes the cart funnel already covered by `/panier`;
 *  `/facture` serves order-receipt PII (UUID-gated + noindex, blocked here too
 *  as defense-in-depth so a leaked receipt URL never enters a crawl). */
export const PRIVATE_AREAS = ["/admin", "/api", "/account", "/favoris", "/panier", "/checkout", "/facture"];

export function buildRobotsTxt(input: RobotsInput): string {
  const { origin, siteName, indexable, extraDisallow, feeds, markdownEnabled, siteClosed } = input;
  const sitemap = `${origin}/sitemap.xml`;
  const llms = `${origin}/llms.txt`;
  const out: string[] = [];

  out.push(`# ${siteName} — robots.txt`);

  // Store closed (maintenance / pre-launch): every URL serves the gate scene and
  // the sitemap/feeds/search are emptied — suspend crawling entirely. No sitemap
  // or llms.txt pointer: there is nothing to advertise until the store re-opens.
  if (siteClosed) {
    out.push("# Boutique temporairement fermée (maintenance / ouverture prochaine) — exploration suspendue.");
    out.push("");
    out.push("User-agent: *");
    out.push("Disallow: /");
    return out.join("\n") + "\n";
  }

  out.push(`# Plan lisible par IA (llms.txt) : ${llms}`);
  out.push("");

  // Master kill-switch (SEO → Indexation): discourage ALL indexing site-wide.
  if (!indexable) {
    out.push("User-agent: *");
    out.push("Disallow: /");
    out.push("");
    out.push(`Sitemap: ${sitemap}`);
    return out.join("\n") + "\n";
  }

  out.push("User-agent: *");
  out.push("Allow: /");
  for (const p of PRIVATE_AREAS) out.push(`Disallow: ${p}`);
  for (const p of extraDisallow) out.push(`Disallow: ${p}`);

  // Machine feed surface: block enumeration of /feeds, but explicitly ALLOW each
  // ENABLED feed file so Google Merchant's scheduled fetch + AI shopping agents
  // can fetch it (a longer, more specific Allow overrides the shorter Disallow).
  out.push("Disallow: /feeds");
  const feedRefs: string[] = [];
  if (feeds.google.enabled) {
    out.push(`Allow: /feeds/${feeds.google.path}`);
    feedRefs.push(`# Flux Google Merchant : ${origin}/feeds/${feeds.google.path}`);
  }
  if (feeds.acp.enabled) {
    out.push(`Allow: /feeds/${feeds.acp.path}`);
    feedRefs.push(`# Flux Agentic Commerce (ACP) : ${origin}/feeds/${feeds.acp.path}`);
  }

  // Markdown-for-agents twins are noindex duplicates of canonical HTML pages — keep
  // them out of the index. Agents still reach the Markdown via content negotiation
  // on the canonical URL (allowed). Only emitted while the feature is active.
  if (markdownEnabled) {
    out.push("Disallow: /md");
    out.push("Disallow: /*.md$");
  }

  out.push("");
  if (feedRefs.length > 0) {
    out.push("# Flux produits (ingestion shopping / IA) :");
    out.push(...feedRefs);
    out.push("");
  }
  out.push(`Sitemap: ${sitemap}`);
  return out.join("\n") + "\n";
}
