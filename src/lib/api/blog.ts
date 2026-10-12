import "server-only";

import { createHash } from "node:crypto";

import { sanitizeRichHtml } from "@/lib/sanitize/rich-html";
import {
  listPublishedPosts,
  getPublishedPostBySlug,
  listAllCategories,
  countPublishedPostsByCategory,
  type PublicBlogPost,
} from "@/modules/blog/queries";

/**
 * Headless blog read API — curates the public `PublicBlogPost` shape into a
 * stable DTO (no internal flags / soft-delete / author id). Bodies are STORED as
 * raw admin HTML (nothing sanitises on write), so `body` is serialised through
 * `sanitizeRichHtml` — the same pass the storefront page renders with (scripts /
 * on*-handlers stripped, media restricted to our own `/cdn/` proxy), so a head
 * gets exactly what the site shows. Consumers should still sanitise on render.
 */
export type ApiBlogPost = {
  slug: string;
  title: string;
  excerpt: string | null;
  body: string;
  readingMinutes: number | null;
  publishedAt: string | null;
  metaTitle: string | null;
  metaDescription: string | null;
  image: string | null;
  imageAlt: string | null;
  category: { slug: string; name: string } | null;
  tags: { slug: string; name: string }[];
};

/**
 * `sanitizeRichHtml` is synchronous jsdom work (~5–12 ms per 5–15 KB body), and
 * the listing DTO carries every body — `/md/blog` (+ category twin) pulls up to
 * 100 posts per hit and `?`-query variants bypass the CDN cache, so sanitising
 * per call would block the event loop for ~1 s per anonymous request. Memoise
 * the sanitised output per DISTINCT body: keyed on the raw body's content hash
 * (sha1 ≈ 20 µs), so an edit is a new key and stale HTML can never be served
 * (no reliance on an updated_at bump). Bounded LRU — a hit is re-inserted at
 * the tail, the oldest entry is evicted once full.
 */
const SAFE_BODY_MEMO_MAX = 500;
const SAFE_BODY_MEMO = new Map<string, string>();

function safeBody(html: string): string {
  const key = createHash("sha1").update(html).digest("base64");
  const hit = SAFE_BODY_MEMO.get(key);
  if (hit !== undefined) {
    SAFE_BODY_MEMO.delete(key);
    SAFE_BODY_MEMO.set(key, hit);
    return hit;
  }
  const clean = sanitizeRichHtml(html);
  if (SAFE_BODY_MEMO.size >= SAFE_BODY_MEMO_MAX) {
    const oldest = SAFE_BODY_MEMO.keys().next().value;
    if (oldest !== undefined) SAFE_BODY_MEMO.delete(oldest);
  }
  SAFE_BODY_MEMO.set(key, clean);
  return clean;
}

function serialize(p: PublicBlogPost): ApiBlogPost {
  return {
    slug: p.slug,
    title: p.title,
    excerpt: p.excerpt,
    body: safeBody(p.body),
    readingMinutes: p.reading_minutes,
    publishedAt: p.published_at ? p.published_at.toISOString() : null,
    metaTitle: p.meta_title,
    metaDescription: p.meta_description,
    image: p.featuredImageUrl,
    imageAlt: p.featuredImageAlt,
    category: p.category ? { slug: p.category.slug, name: p.category.name } : null,
    tags: p.tags.map((t) => ({ slug: t.slug, name: t.name })),
  };
}

export async function listApiBlogPosts(opts: {
  limit?: number;
  cursor?: string;
  categorySlug?: string;
}): Promise<{ items: ApiBlogPost[]; nextCursor: string | null }> {
  const { items, nextCursor } = await listPublishedPosts(opts);
  return { items: items.map(serialize), nextCursor };
}

export async function getApiBlogPost(slug: string): Promise<ApiBlogPost | null> {
  const post = await getPublishedPostBySlug(slug);
  return post ? serialize(post) : null;
}

export async function listApiBlogCategories(): Promise<{ slug: string; name: string }[]> {
  // Mirror the sitemap's exclusion contract (migration 0186 `noindex` + empty
  // categories are dropped) so the public API surface / llms.txt never advertises
  // a /blog/<slug> the site deliberately keeps out of search.
  const [cats, counts] = await Promise.all([listAllCategories(), countPublishedPostsByCategory()]);
  return cats
    .filter((c) => c.is_active && !c.noindex && (counts.get(c.id) ?? 0) > 0)
    .map((c) => ({ slug: c.slug, name: c.name }));
}
