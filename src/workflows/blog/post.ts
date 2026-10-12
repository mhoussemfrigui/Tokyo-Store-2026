import "server-only";

import { z } from "zod";

import { blogService } from "@/modules/blog/service";
import { bus } from "@/events/bus";
import { db } from "@/lib/db/client";
import { isUniqueViolation } from "@/lib/db/pg-errors";
import { slugSchema, slugify } from "../helpers";
import { fail, ok, workflow } from "../shared";

/**
 * Optional free-text column → stored value. A blank (or whitespace-only) string
 * becomes NULL: the edit form always submits the SEO/excerpt fields and the
 * action sends "" as its "clear this field" sentinel, and a stored "" would beat
 * the storefront `??` fallbacks (meta title → post title, meta description →
 * excerpt), rendering the site-default <title> and dropping the description.
 */
function blankToNull(value: string | null | undefined): string | null {
  return value?.trim() || null;
}

export const createBlogPostSchema = z.object({
  title: z.string().trim().min(1).max(200),
  slug: slugSchema.optional(),
  excerpt: z.string().max(500).optional(),
  body: z.string().default(""),
  // nullable so an update can CLEAR the category / cover / author (the action
  // sends null when the field is present-but-blank; undefined means "leave
  // unchanged").
  categoryId: z.string().uuid().nullable().optional(),
  authorId: z.string().uuid().nullable().optional(),
  featuredImageMediaId: z.string().uuid().nullable().optional(),
  readingMinutes: z.number().int().min(1).max(120).optional(),
  metaTitle: z.string().optional(),
  metaDescription: z.string().optional(),
  publish: z.boolean().default(false),
  tagIds: z.array(z.string().uuid()).default([]),
});

export const createBlogPostWorkflow = workflow<
  [z.input<typeof createBlogPostSchema>, { actorUserId: string }],
  { postId: string; slug: string }
>("blog.post.create", async (input, { actorUserId }) => {
  const parsed = createBlogPostSchema.safeParse(input);
  if (!parsed.success) return fail("validation", "Validation échouée");
  const d = parsed.data;

  const slug = d.slug ?? slugify(d.title);
  // A title with no Latin characters slugifies to "" — reject rather than create
  // an unreachable post (the /blog/[slug] segment can't match an empty path).
  if (!slugSchema.safeParse(slug).success)
    return fail("validation", "Impossible de générer un identifiant URL depuis ce titre — saisissez un slug.");
  const existing = await blogService.findPostBySlug(slug);
  if (existing) return fail("conflict", "Slug déjà utilisé.");
  // Posts + categories share the flat /blog/<slug> namespace — keep them mutually
  // unique so a category can never be shadowed by a post (post wins at the route).
  if (await blogService.findCategoryBySlug(slug))
    return fail("conflict", "Ce slug est déjà pris par une catégorie blog.");

  // Auto-compute reading_minutes if the admin didn't provide an override —
  // ~200 words/minute is the standard for casual web reading.
  const readingMinutes = d.readingMinutes ?? computeReadingMinutes(d.body);

  let post;
  try {
    post = await db.transaction(async (tx) => {
      const inserted = await blogService.insertPost({
        title: d.title,
        slug,
        excerpt: blankToNull(d.excerpt),
        body: d.body,
        category_id: d.categoryId ?? null,
        author_user_id: actorUserId,
        author_id: d.authorId ?? null,
        featured_image_media_id: d.featuredImageMediaId ?? null,
        reading_minutes: readingMinutes,
        meta_title: blankToNull(d.metaTitle),
        meta_description: blankToNull(d.metaDescription),
        is_published: d.publish,
        published_at: d.publish ? new Date() : null,
      }, tx);
      if (d.tagIds.length > 0) {
        await blogService.setPostTags(inserted.id, d.tagIds, tx);
      }
      return inserted;
    });
  } catch (err) {
    // Lost the slug race against a concurrent insert (the pre-check passed but
    // the unique index won) — surface a clean conflict, not a 500.
    if (isUniqueViolation(err)) return fail("conflict", "Slug déjà utilisé.");
    throw err;
  }

  await bus.emit("blog.post.created", { postId: post.id, slug: post.slug }, { actorUserId });
  if (post.is_published) {
    await bus.emit("blog.post.published", { postId: post.id, slug: post.slug }, { actorUserId });
  }
  return ok({ postId: post.id, slug: post.slug });
});

export const updateBlogPostSchema = createBlogPostSchema
  .partial()
  .extend({ postId: z.string().uuid() });

export const updateBlogPostWorkflow = workflow<
  [z.input<typeof updateBlogPostSchema>, { actorUserId: string }],
  { postId: string }
>("blog.post.update", async (input, { actorUserId }) => {
  const parsed = updateBlogPostSchema.safeParse(input);
  if (!parsed.success) return fail("validation", "Validation échouée");
  const d = parsed.data;

  const existing = await blogService.findPostById(d.postId);
  if (!existing) return fail("not_found", "Article introuvable.");

  // Slug change must remain unique — among posts AND categories (shared /blog/<slug>).
  if (d.slug !== undefined && d.slug !== existing.slug) {
    const dup = await blogService.findPostBySlug(d.slug);
    if (dup && dup.id !== existing.id) return fail("conflict", "Slug déjà utilisé.");
    if (await blogService.findCategoryBySlug(d.slug))
      return fail("conflict", "Ce slug est déjà pris par une catégorie blog.");
  }

  const patch: Parameters<typeof blogService.updatePost>[1] = {};
  if (d.title !== undefined) patch.title = d.title;
  if (d.slug !== undefined) patch.slug = d.slug;
  if (d.excerpt !== undefined) patch.excerpt = blankToNull(d.excerpt);
  if (d.body !== undefined) patch.body = d.body;
  if (d.categoryId !== undefined) patch.category_id = d.categoryId;
  if (d.authorId !== undefined) patch.author_id = d.authorId;
  if (d.featuredImageMediaId !== undefined)
    patch.featured_image_media_id = d.featuredImageMediaId ?? null;
  if (d.readingMinutes !== undefined) {
    patch.reading_minutes = d.readingMinutes ?? null;
  } else if (d.body !== undefined) {
    // Recompute reading_minutes when body changes and the admin didn't pin
    // a manual value in the same submit.
    patch.reading_minutes = computeReadingMinutes(d.body);
  }
  if (d.metaTitle !== undefined) patch.meta_title = blankToNull(d.metaTitle);
  if (d.metaDescription !== undefined) patch.meta_description = blankToNull(d.metaDescription);

  let publishEvent: "published" | "unpublished" | null = null;
  if (d.publish !== undefined && d.publish !== existing.is_published) {
    patch.is_published = d.publish;
    patch.published_at = d.publish ? new Date() : existing.published_at;
    publishEvent = d.publish ? "published" : "unpublished";
  }

  try {
    await db.transaction(async (tx) => {
      if (Object.keys(patch).length > 0) await blogService.updatePost(d.postId, patch, tx);
      if (d.tagIds !== undefined) await blogService.setPostTags(d.postId, d.tagIds, tx);
    });
  } catch (err) {
    if (isUniqueViolation(err)) return fail("conflict", "Slug déjà utilisé.");
    throw err;
  }

  await bus.emit("blog.post.updated", { postId: d.postId, slug: existing.slug }, { actorUserId });
  if (publishEvent === "published") {
    await bus.emit("blog.post.published", { postId: d.postId, slug: existing.slug }, { actorUserId });
  } else if (publishEvent === "unpublished") {
    await bus.emit("blog.post.unpublished", { postId: d.postId, slug: existing.slug }, { actorUserId });
  }

  return ok({ postId: d.postId });
});

export const togglePostPublishSchema = z.object({
  postId: z.string().uuid(),
  publish: z.boolean(),
});

export const togglePostPublishWorkflow = workflow<
  [z.input<typeof togglePostPublishSchema>, { actorUserId: string }],
  { postId: string }
>("blog.post.toggle_publish", async (input, { actorUserId }) => {
  const parsed = togglePostPublishSchema.safeParse(input);
  if (!parsed.success) return fail("validation", "Validation échouée");

  const existing = await blogService.findPostById(parsed.data.postId);
  if (!existing) return fail("not_found", "Article introuvable.");
  // Already in the requested state (a stale second admin tab re-clicking the
  // chip): no-op. Re-publishing would re-stamp published_at (jumping the post
  // to the top of the date-sorted listing and changing its « Publié le ») and
  // re-emit a duplicate blog.post.published to webhook consumers.
  if (existing.is_published === parsed.data.publish) return ok({ postId: existing.id });

  const updated = await blogService.updatePost(parsed.data.postId, {
    is_published: parsed.data.publish,
    published_at: parsed.data.publish ? new Date() : existing.published_at,
  });
  if (!updated) return fail("not_found", "Article introuvable.");

  await bus.emit(
    parsed.data.publish ? "blog.post.published" : "blog.post.unpublished",
    { postId: updated.id, slug: updated.slug },
    { actorUserId },
  );
  return ok({ postId: updated.id });
});

/**
 * Estimate reading time at ~200 wpm. Strips HTML tags first so TipTap-output
 * markup doesn't inflate the count. Always returns at least 1 minute.
 */
function computeReadingMinutes(body: string): number {
  const plain = body.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  if (plain.length === 0) return 1;
  const words = plain.split(" ").length;
  return Math.max(1, Math.round(words / 200));
}

export const deleteBlogPostWorkflow = workflow<
  [{ postId: string }, { actorUserId: string }],
  { postId: string }
>("blog.post.delete", async ({ postId }, { actorUserId }) => {
  // Existence check before the soft delete so a stale admin click on an
  // already-removed post returns a clean not_found instead of a silent
  // success that still emits a `blog.post.deleted` event.
  const existing = await blogService.findPostById(postId);
  if (!existing) return fail("not_found", "Article introuvable.");

  await blogService.softDeletePost(postId);
  await bus.emit("blog.post.deleted", { postId }, { actorUserId });
  return ok({ postId });
});

export const restoreBlogPostWorkflow = workflow<
  [{ postId: string }, { actorUserId: string }],
  { postId: string }
>("blog.post.restore", async ({ postId }, { actorUserId }) => {
  // A category may have claimed the post's flat /blog/<slug> while it was archived
  // (the create-category guard only checks LIVE posts), so restoring would silently
  // shadow that category at the route. Re-check the collision before un-archiving.
  const archived = await blogService.findArchivedPostById(postId);
  if (!archived) return fail("not_found", "Article archivé introuvable.");
  if (await blogService.findCategoryBySlug(archived.slug))
    return fail(
      "conflict",
      "Ce slug est désormais pris par une catégorie blog. Renommez la catégorie avant de restaurer.",
    );

  // restorePost only matches a SOFT-DELETED row, so a null result means the id
  // is unknown or already active — either way nothing to restore.
  const restored = await blogService.restorePost(postId);
  if (!restored) return fail("not_found", "Article archivé introuvable.");
  await bus.emit("blog.post.updated", { postId, slug: restored.slug }, { actorUserId });
  // The archive emitted blog.post.deleted, so a consumer that dropped the id
  // needs a publish signal to re-list a restored LIVE post (a restored draft
  // stays unlisted — `updated` is enough).
  if (restored.is_published) {
    await bus.emit("blog.post.published", { postId, slug: restored.slug }, { actorUserId });
  }
  return ok({ postId });
});
