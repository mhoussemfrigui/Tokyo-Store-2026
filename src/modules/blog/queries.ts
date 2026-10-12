import "server-only";

import { cacheTag, cacheLife } from "next/cache";

import { blogService, type BlogListSort } from "./service";
import { mediaQueries } from "@/modules/media";
import { authorQueries, type PublicAuthorRef } from "@/modules/authors";
import { CACHE_TAGS } from "@/lib/cache/tags";
import type { BlogPostRow, BlogCategoryRow, BlogTagRow } from "./schema";

export type PublicBlogPost = BlogPostRow & {
  featuredImageUrl: string | null;
  /** Médiathèque alt for the featured image — falls back to the title at render. */
  featuredImageAlt: string | null;
  category: BlogCategoryRow | null;
  tags: BlogTagRow[];
  /** Editorial author profile (byline + Person schema); null = fallback byline. */
  author: PublicAuthorRef | null;
};

export async function listPublishedPosts(opts: {
  limit?: number;
  cursor?: string;
  categorySlug?: string;
} = {}): Promise<{ items: PublicBlogPost[]; nextCursor: string | null }> {
  "use cache";
  // First incremental `'use cache'` adoption (see next.config.ts useCache). The
  // result is cached per (limit,cursor,categorySlug) and tagged so the
  // invalidate-blog-cache subscriber's `revalidateTag(blog:posts/categories)`
  // busts it the instant an admin writes. `cacheLife("hours")` is the
  // staleness floor (self-heals even if a revalidate is ever missed). No
  // request-scoped data (cookies/headers) is read here, so it is cache-safe.
  cacheLife("hours");
  cacheTag(CACHE_TAGS.blogPosts, CACHE_TAGS.blogCategories);

  let categoryId: string | undefined;
  if (opts.categorySlug) {
    const cat = await blogService.findCategoryBySlug(opts.categorySlug);
    // An INACTIVE category is gone from the storefront (its page 404s and
    // ?categories=1 hides it), so it lists nothing here either (/api/blog, /md).
    if (!cat || !cat.is_active) return { items: [], nextCursor: null };
    categoryId = cat.id;
  }

  const { items, nextCursor } = await blogService.listPosts({
    publishedOnly: true,
    limit: opts.limit,
    cursor: opts.cursor,
    categoryId,
    withTotal: false, // public listing uses the cursor, never the count
  });

  return { items: await enrichPosts(items), nextCursor };
}

export async function getPublishedPostBySlug(slug: string): Promise<PublicBlogPost | null> {
  const post = await blogService.findPostBySlug(slug);
  if (!post || !post.is_published) return null;
  const [enriched] = await enrichPosts([post]);
  return enriched;
}

/**
 * Public listing for a tag archive (`/blog/tag/<slug>`). Resolves the tag,
 * then the published posts carrying it, enriched like the other listings.
 * Returns `{ tag: null }` when the slug doesn't exist so the page can 404.
 */
export async function listPublishedPostsByTag(
  slug: string,
  opts: { limit?: number; cursor?: string } = {},
): Promise<{ tag: BlogTagRow | null; items: PublicBlogPost[]; nextCursor: string | null }> {
  const tag = await blogService.findTagBySlug(slug);
  if (!tag) return { tag: null, items: [], nextCursor: null };
  const { items, nextCursor } = await blogService.listPublishedPostsByTagId(tag.id, {
    limit: opts.limit ?? 24,
    cursor: opts.cursor,
  });
  return { tag, items: await enrichPosts(items), nextCursor };
}

/**
 * PUBLIC full-text search (the /blog?q=… surface). Relevance-ranked published
 * posts for a free-text query, enriched like the other listings, with the total
 * for offset pagination. NOT `'use cache'` — the query space is unbounded + the
 * GIN-indexed FTS is already cheap, so per-term caching would just churn.
 */
export async function searchPublishedPosts(
  q: string,
  opts: { limit?: number; offset?: number } = {},
): Promise<{ items: PublicBlogPost[]; total: number }> {
  const { items, total } = await blogService.searchPublishedPosts(q, opts);
  return { items: await enrichPosts(items), total };
}

/**
 * OFFSET-paginated published listing for the crimson blog redesign (numbered
 * pages). Resolves category/tag slugs → ids, applies « Récents »/« Populaires »
 * sort, and enriches cards. Returns the total so the UI can render numbered
 * pages. Inactive category / unknown tag → empty. Not `'use cache'` (sort×page
 * combos; the query is index-backed and cheap).
 */
export async function listPublishedPagedPosts(opts: {
  categorySlug?: string;
  tagSlug?: string;
  sort?: BlogListSort;
  page?: number;
  pageSize?: number;
} = {}): Promise<{ items: PublicBlogPost[]; total: number }> {
  const pageSize = Math.min(Math.max(opts.pageSize ?? 12, 1), 50);
  const page = Math.max(opts.page ?? 1, 1);

  let categoryId: string | undefined;
  if (opts.categorySlug) {
    const cat = await blogService.findCategoryBySlug(opts.categorySlug);
    if (!cat || !cat.is_active) return { items: [], total: 0 };
    categoryId = cat.id;
  }
  let tagId: string | undefined;
  if (opts.tagSlug) {
    const tag = await blogService.findTagBySlug(opts.tagSlug);
    if (!tag) return { items: [], total: 0 };
    tagId = tag.id;
  }

  const { items, total } = await blogService.listPublishedPaged({
    categoryId,
    tagId,
    sort: opts.sort,
    limit: pageSize,
    offset: (page - 1) * pageSize,
  });
  // The list omits the heavy body; enrich only needs the lightweight columns.
  const enriched = await enrichPosts(items.map((r) => ({ ...r, body: "" })));
  return { items: enriched, total };
}

/** Slug + dates for the sitemap (no enrich pipeline). */
export async function listPublishedPostSlugs(limit = 1000) {
  return blogService.listPublishedPostSlugs(limit);
}

export async function listAllCategories() {
  return blogService.listCategories();
}

/** Published-post counts per category id (sitemap drops empty categories). */
export async function countPublishedPostsByCategory() {
  return blogService.countPublishedPostsByCategory();
}

async function enrichPosts(posts: BlogPostRow[]): Promise<PublicBlogPost[]> {
  if (posts.length === 0) return [];

  // Resolve featured images via the public media barrel. Uses the COMPAT
  // (never-AVIF) resolver because `featuredImageUrl` feeds `og:image` +
  // JSON-LD `image` (social scrapers / Google rich results can't render
  // AVIF); the on-page `<Image>` hero still up-negotiates webp→AVIF.
  const mediaMap = await mediaQueries.resolveSocialUrlAltMap(
    posts.map((p) => p.featured_image_media_id).filter((x): x is string => !!x),
  );

  // Resolve categories in one batched query (no per-post round-trips).
  const categoryIds = Array.from(
    new Set(posts.map((p) => p.category_id).filter((x): x is string => !!x)),
  );
  const categoryMap = await blogService.findCategoriesByIds(categoryIds);

  // Resolve tags (batched).
  const tagsByPost = await blogService.findTagsForPosts(posts.map((p) => p.id));

  // Resolve editorial author profiles (batched — one authors + one media query).
  const authorMap = await authorQueries.resolveAuthorRefs(posts.map((p) => p.author_id));

  return posts.map((p) => {
    const media = p.featured_image_media_id ? mediaMap.get(p.featured_image_media_id) ?? null : null;
    // An INACTIVE category is exposed as none: its /blog/category page 404s, so
    // the post's pill link + BreadcrumbList crumb (and the API DTO) must not
    // point at it.
    const category = p.category_id ? categoryMap.get(p.category_id) ?? null : null;
    return {
      ...p,
      featuredImageUrl: media?.url ?? null,
      featuredImageAlt: media?.alt ?? null,
      category: category?.is_active ? category : null,
      tags: tagsByPost.get(p.id) ?? [],
      author: p.author_id ? authorMap.get(p.author_id) ?? null : null,
    };
  });
}
