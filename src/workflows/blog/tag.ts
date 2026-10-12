import "server-only";

import { z } from "zod";

import { blogService } from "@/modules/blog/service";
import { bus } from "@/events/bus";
import { isUniqueViolation } from "@/lib/db/pg-errors";
import { slugSchema, slugify } from "../helpers";
import { fail, ok, workflow } from "../shared";

export const createTagSchema = z.object({
  name: z.string().trim().min(1).max(80),
  slug: slugSchema.optional(),
});

export const createTagWorkflow = workflow<
  [z.input<typeof createTagSchema>, { actorUserId: string }],
  { tagId: string; slug: string }
>("blog.tag.create", async (input, { actorUserId }) => {
  const parsed = createTagSchema.safeParse(input);
  if (!parsed.success) return fail("validation", "Validation échouée");

  const slug = parsed.data.slug ?? slugify(parsed.data.name);
  // A name with no Latin characters slugifies to "" — reject rather than store a
  // dead, unreachable tag.
  if (!slugSchema.safeParse(slug).success)
    return fail("validation", "Impossible de générer un identifiant URL depuis ce nom — saisissez un slug.");
  const existing = await blogService.findTagBySlug(slug);
  if (existing) return fail("conflict", "Slug déjà utilisé.");

  let tag;
  try {
    tag = await blogService.insertTag({ name: parsed.data.name, slug });
  } catch (err) {
    if (isUniqueViolation(err)) return fail("conflict", "Slug déjà utilisé.");
    throw err;
  }

  await bus.emit("blog.tag.created", { tagId: tag.id, slug: tag.slug }, { actorUserId });
  return ok({ tagId: tag.id, slug: tag.slug });
});

export const updateTagSchema = z.object({
  tagId: z.string().uuid(),
  name: z.string().trim().min(1).max(80).optional(),
  slug: slugSchema.optional(),
});

export const updateTagWorkflow = workflow<
  [z.input<typeof updateTagSchema>, { actorUserId: string }],
  { tagId: string }
>("blog.tag.update", async (input, { actorUserId }) => {
  const parsed = updateTagSchema.safeParse(input);
  if (!parsed.success) return fail("validation", "Validation échouée");
  const d = parsed.data;

  const existing = await blogService.findTagById(d.tagId);
  if (!existing) return fail("not_found", "Tag introuvable.");

  if (d.slug !== undefined && d.slug !== existing.slug) {
    const dup = await blogService.findTagBySlug(d.slug);
    if (dup && dup.id !== existing.id) return fail("conflict", "Slug déjà utilisé.");
  }

  const patch: { name?: string; slug?: string } = {};
  if (d.name !== undefined) patch.name = d.name;
  if (d.slug !== undefined) patch.slug = d.slug;
  if (Object.keys(patch).length === 0) return ok({ tagId: d.tagId });

  try {
    const updated = await blogService.updateTag(d.tagId, patch);
    if (!updated) return fail("not_found", "Tag introuvable.");
  } catch (err) {
    if (isUniqueViolation(err)) return fail("conflict", "Slug déjà utilisé.");
    throw err;
  }

  await bus.emit("blog.tag.updated", { tagId: d.tagId, slug: d.slug ?? existing.slug }, { actorUserId });
  return ok({ tagId: d.tagId });
});

export const deleteTagWorkflow = workflow<
  [{ tagId: string }, { actorUserId: string }],
  { tagId: string }
>("blog.tag.delete", async ({ tagId }, { actorUserId }) => {
  // Existence check before deletion so a stale admin click on an already-removed
  // tag returns a clean not_found instead of a silent success that still emits
  // `blog.tag.deleted` (matches post/category delete).
  const existing = await blogService.findTagById(tagId);
  if (!existing) return fail("not_found", "Tag introuvable.");
  await blogService.deleteTag(tagId);
  await bus.emit("blog.tag.deleted", { tagId }, { actorUserId });
  return ok({ tagId });
});
