import "server-only";

import { z } from "zod";

import { blogService } from "@/modules/blog/service";
import { bus } from "@/events/bus";
import { isUniqueViolation } from "@/lib/db/pg-errors";
import { slugSchema, slugify } from "../helpers";
import { fail, ok, workflow } from "../shared";

export const createBlogCategorySchema = z.object({
  name: z.string().trim().min(1).max(120),
  slug: slugSchema.optional(),
  description: z.string().optional(),
  displayOrder: z.number().int().min(0).default(0),
  isActive: z.boolean().default(true),
});

export const createBlogCategoryWorkflow = workflow<
  [z.input<typeof createBlogCategorySchema>, { actorUserId: string }],
  { categoryId: string; slug: string }
>("blog.category.create", async (input, { actorUserId }) => {
  const parsed = createBlogCategorySchema.safeParse(input);
  if (!parsed.success) return fail("validation", "Validation échouée");

  const slug = parsed.data.slug ?? slugify(parsed.data.name);
  // A name with no Latin characters (e.g. an all-Arabic « ساعات ») slugifies to ""
  // — reject it with a clear message instead of persisting a dead, unreachable row.
  if (!slugSchema.safeParse(slug).success)
    return fail("validation", "Impossible de générer un identifiant URL depuis ce nom — saisissez un slug.");
  const existing = await blogService.findCategoryBySlug(slug);
  if (existing) return fail("conflict", "Slug déjà utilisé.");
  // Categories + posts share the flat /blog/<slug> namespace — keep mutually unique.
  if (await blogService.findPostBySlug(slug))
    return fail("conflict", "Ce slug est déjà pris par un article.");

  let cat;
  try {
    cat = await blogService.insertCategory({
      name: parsed.data.name,
      slug,
      description: parsed.data.description ?? null,
      display_order: parsed.data.displayOrder,
      is_active: parsed.data.isActive,
    });
  } catch (err) {
    if (isUniqueViolation(err)) return fail("conflict", "Slug déjà utilisé.");
    throw err;
  }

  await bus.emit(
    "blog.category.created",
    { categoryId: cat.id, slug: cat.slug },
    { actorUserId },
  );
  return ok({ categoryId: cat.id, slug: cat.slug });
});

export const updateBlogCategorySchema = z.object({
  categoryId: z.string().uuid(),
  name: z.string().trim().min(1).max(120).optional(),
  slug: slugSchema.optional(),
  description: z.string().nullable().optional(),
  displayOrder: z.number().int().min(0).optional(),
  isActive: z.boolean().optional(),
  metaTitle: z.string().nullable().optional(),
  metaDescription: z.string().nullable().optional(),
  noindex: z.boolean().optional(),
});

export const updateBlogCategoryWorkflow = workflow<
  [z.input<typeof updateBlogCategorySchema>, { actorUserId: string }],
  { categoryId: string }
>("blog.category.update", async (input, { actorUserId }) => {
  const parsed = updateBlogCategorySchema.safeParse(input);
  if (!parsed.success) return fail("validation", "Validation échouée");

  const existing = await blogService.findCategoryById(parsed.data.categoryId);
  if (!existing) return fail("not_found", "Catégorie introuvable.");

  const patch: Record<string, unknown> = {};
  const changed: string[] = [];
  if (parsed.data.name !== undefined && parsed.data.name !== existing.name) {
    patch.name = parsed.data.name;
    changed.push("name");
  }
  if (parsed.data.slug !== undefined && parsed.data.slug !== existing.slug) {
    const dup = await blogService.findCategoryBySlug(parsed.data.slug);
    if (dup && dup.id !== existing.id) return fail("conflict", "Slug déjà utilisé.");
    if (await blogService.findPostBySlug(parsed.data.slug))
      return fail("conflict", "Ce slug est déjà pris par un article.");
    patch.slug = parsed.data.slug;
    changed.push("slug");
  }
  if (parsed.data.description !== undefined) {
    patch.description = parsed.data.description;
    changed.push("description");
  }
  if (parsed.data.metaTitle !== undefined) {
    patch.meta_title = parsed.data.metaTitle;
    changed.push("meta_title");
  }
  if (parsed.data.metaDescription !== undefined) {
    patch.meta_description = parsed.data.metaDescription;
    changed.push("meta_description");
  }
  if (parsed.data.noindex !== undefined && parsed.data.noindex !== existing.noindex) {
    patch.noindex = parsed.data.noindex;
    changed.push("noindex");
  }
  if (parsed.data.displayOrder !== undefined) {
    patch.display_order = parsed.data.displayOrder;
    changed.push("display_order");
  }
  if (parsed.data.isActive !== undefined && parsed.data.isActive !== existing.is_active) {
    patch.is_active = parsed.data.isActive;
    changed.push("is_active");
  }
  if (Object.keys(patch).length > 0) {
    try {
      await blogService.updateCategory(existing.id, patch);
    } catch (err) {
      if (isUniqueViolation(err)) return fail("conflict", "Slug déjà utilisé.");
      throw err;
    }
    await bus.emit(
      "blog.category.updated",
      { categoryId: existing.id, changedFields: changed },
      { actorUserId },
    );
  }
  return ok({ categoryId: existing.id });
});

export const deleteBlogCategoryWorkflow = workflow<
  [{ categoryId: string }, { actorUserId: string }],
  { categoryId: string }
>("blog.category.delete", async ({ categoryId }, { actorUserId }) => {
  // Existence check before deletion so a stale admin click on an
  // already-removed category returns a clean not_found instead of a silent
  // success that still emits `blog.category.deleted` (matches post delete).
  const existing = await blogService.findCategoryById(categoryId);
  if (!existing) return fail("not_found", "Catégorie introuvable.");
  await blogService.deleteCategory(categoryId);
  await bus.emit("blog.category.deleted", { categoryId }, { actorUserId });
  return ok({ categoryId });
});
