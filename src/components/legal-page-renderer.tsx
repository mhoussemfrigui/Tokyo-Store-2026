import type { ReactNode } from "react";

import { getPageForRender, resolvePageBlocks } from "@/lib/pages/page-blocks-data";
import { PageBlocksRenderer } from "@/components/storefront/page/page-blocks-render";
import { PageInfoNav } from "@/components/storefront/page/page-info-nav";
import { getMaisonExploreNav } from "@/lib/api/cms";
import { getSeoConfig } from "@/lib/seo/config";
import { buildCmsPageGraph } from "@/lib/seo/jsonld";
import { JsonLd } from "@/components/seo/json-ld";

/**
 * Renders a CMS page by slug in the luxury `.storefront` language (Playfair
 * headings, olive eyebrows, luxury divider, refined prose) through the shared
 * block pipeline (getPageForRender → resolvePageBlocks → PageBlocksRenderer).
 * Used by every legal/system route (`/cgu`, `/cgv`, `/privacy`, `/cookies`,
 * `/mentions-legales`, `/about`, …) so the admin composes them from a single
 * place at `/admin/cms/pages`.
 *
 * `/help` renders the SAME block pipeline directly (not this wrapper) because it
 * appends its own settings-driven contact + showroom sections below the body.
 *
 * Fallback chain when no PUBLISHED CMS page with at least one VISIBLE block
 * exists (unpublished, or published but emptied / all blocks hidden):
 *   1. system pages (cgu/cgv/cookies/privacy/mentions-legales/help/…) → built-in
 *      default public content (these MUST be live out of the box — a published
 *      but empty shell must never blank the legal text);
 *   2. otherwise → a neutral public placeholder (never back-office paths or
 *      authoring instructions — this is a customer-facing page).
 * The DB wins as soon as a published override has visible content.
 */

/** Public copy when a page has nothing to show and no built-in default. */
const PUBLIC_PLACEHOLDER_HINT = "Cette page sera bientôt disponible.";

/**
 * The hint is an operator-configurable string (settings `pages.*.empty_hint`)
 * or a route default; either may still reference the back-office. Never print
 * an admin path on a public page — fall back to the neutral copy instead.
 */
function publicHint(hint: string): string {
  return /\/admin\b/i.test(hint) ? PUBLIC_PLACEHOLDER_HINT : hint;
}

/**
 * Shared luxury page shell — an entry-animated, centred header (serif title +
 * luxury divider) over a generous content column, used for the empty/placeholder
 * fallback so its chrome matches the block renderer's header.
 */
function LuxuryPageShell({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="mx-auto max-w-4xl px-5 py-16 sm:px-6 sm:py-24 lg:py-28">
      <header className="tk-fade-in-up text-center">
        <h1 className="font-serif text-3xl font-normal tracking-tight text-foreground sm:text-4xl lg:text-5xl">
          {title}
        </h1>
        <div className="luxury-divider mx-auto mt-8 w-28" />
      </header>
      <div className="mt-12 space-y-16 sm:mt-16 sm:space-y-20">{children}</div>
    </div>
  );
}

export async function LegalPageRenderer({
  slug,
  fallbackTitle,
  fallbackHint,
}: {
  slug: string;
  fallbackTitle: string;
  fallbackHint: string;
}) {
  // Block path: getPageForRender follows the non-destructive fallback chain (stored
  // pages.blocks → synthesised legacy sections → the system default HTML → null), so a
  // legal/system page is never blank even before its DB row is populated/published.
  // The « Explorer la maison » index (CMS → Footer) is fetched alongside the page —
  // independent reads, and it never throws (built-in defaults on a DB error).
  const [forRender, exploreNav, seo] = await Promise.all([
    getPageForRender(slug).catch(() => null),
    getMaisonExploreNav(),
    getSeoConfig().catch(() => null),
  ]);
  if (!forRender) {
    return (
      <LuxuryPageShell title={fallbackTitle}>
        <div className="mx-auto max-w-3xl rounded-2xl border border-dashed border-border/60 bg-card/60 p-8 text-center text-sm leading-relaxed text-muted-foreground">
          <p>{publicHint(fallbackHint)}</p>
        </div>
      </LuxuryPageShell>
    );
  }
  const resolved = await resolvePageBlocks(forRender).catch(() => null);
  if (!resolved) {
    return (
      <LuxuryPageShell title={forRender.page.title}>
        <div className="mx-auto max-w-3xl rounded-2xl border border-dashed border-border/60 bg-card/60 p-8 text-center text-sm leading-relaxed text-muted-foreground">
          <p>{publicHint(fallbackHint)}</p>
        </div>
      </LuxuryPageShell>
    );
  }
  // WebPage + BreadcrumbList structured data — only for an INDEXABLE page (skip
  // when the admin set noindex: a page kept out of the index shouldn't advertise
  // rich data). The @id/url uses the stable site URL (not a canonical override),
  // matching the #webpage convention of the listing + home graphs.
  const page = forRender.page;
  const cmsGraph =
    seo && !page.noindex
      ? buildCmsPageGraph(seo, {
          url: `${seo.siteUrl}/${slug}`,
          name: page.metaTitle?.trim() || page.title,
          description: page.metaDescription,
        })
      : null;
  return (
    <div className="tk-page">
      {cmsGraph && <JsonLd data={cmsGraph} />}
      <PageBlocksRenderer resolved={resolved} />
      <PageInfoNav nav={exploreNav} currentPath={`/${slug}`} />
    </div>
  );
}
