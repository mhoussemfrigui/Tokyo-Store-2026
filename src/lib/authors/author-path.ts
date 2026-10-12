/**
 * Pure URL helpers for the public author archive. ONE place defines the base so
 * the page route, links, canonical, sitemap, and the Person JSON-LD @id never
 * drift.
 *
 * The base is FIXED at /auteur — authors are a single top-level namespace, so the
 * Person @id `${siteUrl}/auteur/<slug>#person` is durable.
 */
export const AUTHOR_BASE = "/auteur";

/** Public archive path for an author, e.g. `/auteur/jean-dupont`. */
export function authorPath(slug: string): string {
  return `${AUTHOR_BASE}/${slug}`;
}

/** Stable schema.org Person @id, e.g. `https://site.tn/auteur/jean-dupont#person`. */
export function authorPersonId(siteUrl: string, slug: string): string {
  return `${siteUrl.replace(/\/$/, "")}${AUTHOR_BASE}/${slug}#person`;
}
