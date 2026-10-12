/**
 * Canonical blog CATEGORY URL builder — the single place that encodes the flat
 * `/blog/<slug>` decision (categories do NOT live under `/blog/category/`). The
 * `/blog/[slug]` route resolves a published POST first, then falls back to an
 * active CATEGORY; post and category slugs are kept mutually unique by the
 * create/update/restore workflows so the flat namespace is never ambiguous, and
 * the legacy `/blog/category/<slug>` route 308-redirects here. Client-safe (a pure
 * string, no deps). Post URLs are the plain `/blog/<slug>` and tag URLs
 * `/blog/tag/<slug>` — trivial enough to inline at their link sites.
 */
export const blogCategoryPath = (slug: string): string => `/blog/${slug}`;
