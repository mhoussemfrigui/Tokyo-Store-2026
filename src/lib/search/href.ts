/**
 * Maps a search-hit kind + slug to its canonical storefront href.
 *
 * The single routing table for search hits — shared by the store search API
 * route and the /recherche page so they can never disagree.
 *
 * Isomorphic + client-safe: pure string logic, no deps.
 */
export function searchHitHref(kind: string, slug: string): string {
  switch (kind) {
    case "product":
      return `/${slug}`;
    case "category":
      return `/${slug}`;
    case "brand":
      return `/${slug}`;
    case "blog_post":
      return `/blog/${slug}`;
    case "page":
      return `/${slug}`;
    default:
      return "/";
  }
}
