import "server-only";

import { authorService } from "./service";
import { mediaQueries } from "@/modules/media";
import type { AuthorRow } from "./schema";

/**
 * Lean author reference for storefront bylines + the in-article JSON-LD Person
 * ref. The full Person node (bio/sameAs/expertise) is built only on the /auteur
 * archive page.
 */
export type PublicAuthorRef = {
  id: string;
  slug: string;
  name: string;
  jobTitle: string | null;
  avatarUrl: string | null;
};

function toRef(row: AuthorRow, avatarUrl: string | null): PublicAuthorRef {
  return { id: row.id, slug: row.slug, name: row.name, jobTitle: row.job_title, avatarUrl };
}

/**
 * Batched byline hydration — one authors query + one media query for N post
 * author ids (no N+1). Consumed by the blog enrich pipeline. Soft-deleted /
 * deactivated authors drop out (findByIds is active-only) so their posts render
 * the fallback byline.
 */
export async function resolveAuthorRefs(
  ids: (string | null | undefined)[],
): Promise<Map<string, PublicAuthorRef>> {
  const authorMap = await authorService.findByIds(ids.filter((x): x is string => !!x));
  const rows = [...authorMap.values()];
  // COMPAT (never-AVIF) resolver — the avatar feeds og:image + JSON-LD
  // Person.image (social scrapers / Google rich results can't render AVIF), same
  // as featured images.
  const avatarMap = await mediaQueries.resolveSocialUrlAltMap(
    rows.map((r) => r.avatar_media_id).filter((x): x is string => !!x),
  );
  const out = new Map<string, PublicAuthorRef>();
  for (const row of rows) {
    const avatar = row.avatar_media_id ? avatarMap.get(row.avatar_media_id) ?? null : null;
    out.set(row.id, toRef(row, avatar?.url ?? null));
  }
  return out;
}

/** Live author by slug — the public /auteur/<slug> archive loader. */
export async function findAuthorBySlug(slug: string) {
  return authorService.findBySlug(slug);
}

/** One archive card — structurally the storefront `BlogCardData` (crimson tile). */
export type AuthorArchivePost = {
  slug: string;
  title: string;
  excerpt: string | null;
  imageUrl: string | null;
  imageAlt: string | null;
  categoryName: string | null;
  publishedAt: string | null;
  readingMinutes: number | null;
};

/**
 * A page of an author's published posts (numbered pagination) with the category +
 * reading time + resolved cover, optionally filtered to one category — the crimson
 * `/auteur/<slug>` archive grid.
 */
export async function getAuthorArchivePage(
  authorId: string,
  opts: { page?: number; pageSize?: number; categorySlug?: string | null } = {},
): Promise<{ posts: AuthorArchivePost[]; total: number }> {
  const { items, total } = await authorService.listPublishedPostsByAuthorPage(authorId, opts);
  const mediaMap = await mediaQueries.resolveSocialUrlAltMap(
    items.map((r) => r.featuredImageMediaId).filter((x): x is string => !!x),
  );
  const posts = items.map((r) => {
    const media = r.featuredImageMediaId ? mediaMap.get(r.featuredImageMediaId) ?? null : null;
    return {
      slug: r.slug,
      title: r.title,
      excerpt: r.excerpt,
      imageUrl: media?.url ?? null,
      imageAlt: media?.alt ?? null,
      categoryName: r.categoryName,
      publishedAt: r.publishedAt ? r.publishedAt.toISOString() : null,
      readingMinutes: r.readingMinutes,
    };
  });
  return { posts, total };
}

/** Archive stats (total / minutes / last / per-category counts) for the header. */
export async function getAuthorStats(authorId: string) {
  return authorService.getAuthorStats(authorId);
}

/** A card in the « Nos autres auteurs » team grid. */
export type OtherAuthorRef = {
  slug: string;
  name: string;
  jobTitle: string | null;
  avatarUrl: string | null;
  count: number;
};

/**
 * Other ACTIVE authors (excluding the current one) that have ≥1 published post —
 * the « L'équipe éditoriale » grid. Most-prolific first; avatars batch-resolved.
 */
export async function listOtherAuthorRefs(excludeId: string, limit = 8): Promise<OtherAuthorRef[]> {
  const [all, counts] = await Promise.all([
    authorService.listActive().catch(() => []),
    authorService.countPublishedPostsByAuthor().catch(() => new Map<string, number>()),
  ]);
  const others = all.filter((a) => a.id !== excludeId && (counts.get(a.id) ?? 0) > 0);
  const avatarMap = await mediaQueries.resolveSocialUrlAltMap(
    others.map((a) => a.avatar_media_id).filter((x): x is string => !!x),
  );
  return others
    .map((a) => ({
      slug: a.slug,
      name: a.name,
      jobTitle: a.job_title,
      avatarUrl: a.avatar_media_id ? avatarMap.get(a.avatar_media_id)?.url ?? null : null,
      count: counts.get(a.id) ?? 0,
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

/** Active (non-deleted) authors — the post-editor selector + any public list. */
export async function listActiveAuthors() {
  return authorService.listActive();
}

/** Published post count per author id — the sitemap has-posts gate. */
export async function countPublishedPostsByAuthor() {
  return authorService.countPublishedPostsByAuthor();
}
