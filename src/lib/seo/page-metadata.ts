import "server-only";

import type { Metadata } from "next";

import { getSeoConfig } from "@/lib/seo/config";
import { composeTitle } from "@/lib/seo/title";
import { mediaQueries } from "@/modules/media";

/**
 * Resolve a médiathèque media id to a same-origin `/cdn` social-share URL for
 * an OG/Twitter image, or null when unset/unresolvable. Uses the AVIF-avoiding
 * SOCIAL resolver (Facebook/LinkedIn don't render AVIF). This is the shared
 * primitive behind every per-page OG image: the CMS-backed file routes
 * (cgv, privacy, about, …) pass their page's `ogImageMediaId` through it so
 * their social card matches what the universal `/[slug]` resolver already
 * emits — without it those routes silently fell back to the global
 * `seo.ogImage`, ignoring the admin's per-page choice. Never throws.
 */
export async function resolveSocialImageUrl(
  mediaId: string | null | undefined,
): Promise<string | null> {
  if (!mediaId) return null;
  const map = await mediaQueries
    .resolveSocialUrlMap([mediaId])
    .catch(() => new Map<string, string>());
  return map.get(mediaId) ?? null;
}

/**
 * SSR page-metadata builder — composes a Next `Metadata` from the admin SEO
 * settings (`getSeoConfig`) so every page's title/description/OG track the
 * store identity instead of hardcoded literals. The brand suffix comes from the
 * admin `seo.title_template` (default "%s · {siteName}"); description, canonical
 * origin, and OG image all default from settings.
 *
 * Usage in a Server Component page:
 *   export async function generateMetadata() {
 *     return buildPageMetadata({ title: "Connexion", path: "/login" });
 *   }
 *
 * Pass `title` WITHOUT the brand suffix (the template adds it). Omit `title`
 * to use the configured default title (e.g. the home page).
 */
export async function buildPageMetadata(opts: {
  /** Page title, WITHOUT the brand suffix — the title template applies it. */
  title?: string;
  /** Page description; falls back to the configured default description. */
  description?: string;
  /** Path for canonical + OG url, e.g. "/login". Omit for the site root. */
  path?: string;
  /** Override indexing for this page; defaults to the global robots setting. */
  index?: boolean;
  /** When noindex, whether crawlers may still FOLLOW links (default true) — so a
   *  thin/archive page (tags, empty category) isn't indexed but its links to
   *  real content still pass equity. Ignored when the page is indexable. */
  follow?: boolean;
  /** Per-page OG/twitter image (e.g. a post cover); falls back to the global
   *  `seo.ogImage` when null/undefined. */
  image?: string | null;
  /** When set, marks the page as an OG `article` with these timestamps (ISO). */
  article?: { publishedTime?: string; modifiedTime?: string };
}): Promise<Metadata> {
  const seo = await getSeoConfig().catch(() => null);
  const siteName = seo?.siteName ?? "Tokyo Store";
  const template = seo?.titleTemplate ?? `%s · ${siteName}`;
  // Compose the final title HERE (strip any baked-in brand, apply template once)
  // and return it as `title.absolute` below — the root layout also defines a
  // `title.template`, so a plain string would get the brand suffix applied a
  // SECOND time ("… · Tokyo Store · Tokyo Store"). absolute opts out of that.
  const title = opts.title
    ? composeTitle(opts.title, siteName, template)
    : seo?.defaultTitle ?? siteName;
  const description = opts.description ?? seo?.defaultDescription ?? undefined;

  const siteUrl = (seo?.siteUrl ?? "").replace(/\/$/, "");
  const url = opts.path
    ? `${siteUrl}${opts.path.startsWith("/") ? "" : "/"}${opts.path}`
    : siteUrl || undefined;
  const ogImage = opts.image ?? seo?.ogImageResolvedUrl ?? seo?.ogImageUrl ?? undefined;
  const robotsIndex = opts.index ?? seo?.robotsIndex ?? true;

  return {
    // absolute → the root layout's title.template is NOT re-applied (no double brand).
    title: { absolute: title },
    description,
    alternates: url ? { canonical: url } : undefined,
    robots: robotsIndex ? undefined : { index: false, follow: opts.follow ?? true },
    openGraph: {
      title,
      description,
      siteName,
      url,
      // Next merges metadata objects SHALLOWLY: this openGraph replaces the root
      // layout's wholesale, so re-declare locale here or every content page loses
      // og:locale (the layout sets it, kept only on the bare home page). fr_TN =
      // French as used in Tunisia (this is a Tunisian store), not France.
      locale: "fr_TN",
      // Carry `alt` on the image (a11y + richer social cards); dimensions are not
      // asserted because a per-entity OG image's size isn't tracked here and a
      // wrong width/height is worse than none.
      images: ogImage ? [{ url: ogImage, alt: title }] : undefined,
      ...(opts.article
        ? {
            type: "article" as const,
            publishedTime: opts.article.publishedTime,
            modifiedTime: opts.article.modifiedTime,
          }
        : { type: "website" as const }),
    },
    twitter: {
      // A large-image card without an image renders as a broken/blank preview —
      // fall back to the text "summary" card when there's no image.
      card: ogImage ? "summary_large_image" : "summary",
      title,
      description,
      // Same shallow-merge reason: thread the store's @handle through so the
      // Twitter card keeps its site attribution off the home page too.
      ...(seo?.twitterHandle ? { site: seo.twitterHandle } : {}),
      images: ogImage ? [{ url: ogImage, alt: title }] : undefined,
    },
  };
}

/**
 * Metadata for a CMS page served by a dedicated file route (/cgv, /apropos, …). Reads ONLY
 * the page ROW (one lightweight query — no block resolution) and
 * honours the admin per-page SEO: meta title/description, og image, an explicit canonical
 * override, and noindex — which still DEFERS to the global robots kill-switch when off (it
 * never forces index on a page the site wants hidden). `fallback` supplies the route's
 * literal title/description when the page is unset/unpublished.
 */
export async function buildCmsPageMetadata(
  slug: string,
  fallback: { title: string; description: string },
): Promise<Metadata> {
  const { pageService } = await import("@/modules/cms/page/service");
  const { getSystemPageDefault } = await import("@/lib/legal/system-page-content");
  const page = await pageService.findBySlug(slug).catch(() => null);
  const live = page?.is_published ? page : null;
  // A page that will render NO real content — unpublished/missing AND with no built-in system
  // default — must be noindex: otherwise its placeholder body ships as an indexable soft-404.
  const rendersNothing = !live && !getSystemPageDefault(slug);
  const base = await buildPageMetadata({
    title: live?.meta_title ?? live?.title ?? fallback.title,
    description: live?.meta_description ?? fallback.description,
    path: `/${slug}`,
    index: page?.noindex || rendersNothing ? false : undefined,
    image: await resolveSocialImageUrl(live?.og_image_media_id ?? null),
  });
  const canonical = page?.canonical_url?.trim();
  return canonical ? { ...base, alternates: { ...base.alternates, canonical } } : base;
}
