import "server-only";

import { bus } from "../bus";
import { CACHE_TAGS, cacheTag } from "@/lib/cache/tags";
import { bustCacheTag as bust } from "@/lib/cache/revalidate";

/**
 * Cache-tag invalidator for the blog module.
 *
 * Blog workflows emit `blog.*` events; this subscriber busts the matching tags
 * (from the single `@/lib/cache/tags` vocabulary) so blog reads recompute the
 * instant an admin writes. The blog listing loader (`listPublishedPosts`) is the
 * first `'use cache'` consumer of these tags; `bustCacheTag` expires it
 * immediately (see that helper for the Next-16 profile-expire gotcha). Other
 * storefront pages remain `force-dynamic`.
 */

export function registerBlogCacheSubscriber() {
  bus.on("blog.post.created", ({ payload }) => {
    bust(CACHE_TAGS.blogPosts);
    bust(cacheTag.blogPostSlug(payload.slug));
  });

  bus.on("blog.post.updated", ({ payload }) => {
    bust(CACHE_TAGS.blogPosts);
    bust(cacheTag.blogPostSlug(payload.slug));
  });

  bus.on("blog.post.published", ({ payload }) => {
    bust(CACHE_TAGS.blogPosts);
    bust(cacheTag.blogPostSlug(payload.slug));
  });

  bus.on("blog.post.unpublished", ({ payload }) => {
    bust(CACHE_TAGS.blogPosts);
    bust(cacheTag.blogPostSlug(payload.slug));
  });

  bus.on("blog.post.deleted", () => {
    bust(CACHE_TAGS.blogPosts);
  });

  bus.on("blog.category.created", ({ payload }) => {
    bust(CACHE_TAGS.blogCategories);
    bust(cacheTag.blogCategory(payload.categoryId));
  });
  bus.on("blog.category.updated", ({ payload }) => {
    bust(CACHE_TAGS.blogCategories);
    bust(cacheTag.blogCategory(payload.categoryId));
  });
  bus.on("blog.category.deleted", ({ payload }) => {
    bust(CACHE_TAGS.blogCategories);
    bust(cacheTag.blogCategory(payload.categoryId));
  });

  // The cached post listing (`listPublishedPosts`) embeds each post's tag rows
  // (name + slug) but is tagged blog:posts/categories only — so a tag RENAME or
  // DELETE must bust blog:posts too, or /api/blog keeps serving the old tag
  // (and its now-404 /blog/tag/<old-slug>) until cacheLife expires. A freshly
  // created tag is on no post yet, so it needs only its own tag.
  bus.on("blog.tag.created", () => bust(CACHE_TAGS.blogTags));
  bus.on("blog.tag.updated", () => {
    bust(CACHE_TAGS.blogTags);
    bust(CACHE_TAGS.blogPosts);
  });
  bus.on("blog.tag.deleted", () => {
    bust(CACHE_TAGS.blogTags);
    bust(CACHE_TAGS.blogPosts);
  });
}
