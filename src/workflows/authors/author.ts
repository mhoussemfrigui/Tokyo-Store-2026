import "server-only";

import { z } from "zod";

import { authorService } from "@/modules/authors/service";
import { bus } from "@/events/bus";
import { isUniqueViolation } from "@/lib/db/pg-errors";
import { slugSchema, slugify } from "../helpers";
import { fail, ok, workflow } from "../shared";

/** Shared field validators reused by create + update (kept in ONE place). */
const metaTitle = z.string().trim().max(70);
const metaDescription = z.string().trim().max(320);
const canonicalUrl = z.string().trim().max(500);

export const createAuthorSchema = z.object({
  name: z.string().trim().min(1).max(160),
  slug: slugSchema.optional(),
  bio: z.string().optional(),
  jobTitle: z.string().trim().max(160).optional(),
  /** Freeform, one entry per line → Person.knowsAbout. */
  expertise: z.string().optional(),
  avatarMediaId: z.string().nullable().optional(),
  /** Freeform, one URL per line → Person.sameAs (sanitised via parseSameAs at render). */
  sameAs: z.string().optional(),
  metaTitle: metaTitle.optional(),
  metaDescription: metaDescription.optional(),
  canonicalUrl: canonicalUrl.optional(),
  noindex: z.boolean().default(false),
  isActive: z.boolean().default(true),
});

export const createAuthorWorkflow = workflow<
  [z.input<typeof createAuthorSchema>, { actorUserId: string }],
  { authorId: string; slug: string }
>("author.create", async (input, { actorUserId }) => {
  const parsed = createAuthorSchema.safeParse(input);
  if (!parsed.success) return fail("validation", "Validation échouée");
  const d = parsed.data;

  const slug = d.slug ?? slugify(d.name);
  // Slug uniqueness among authors (incl. soft-deleted — the unique index ignores
  // deleted_at, so a friendly conflict beats a raw 23505). /auteur/<slug> is its own
  // URL namespace, so there is NO cross-table collision with posts/categories.
  if (await authorService.findBySlugAny(slug)) return fail("conflict", "Slug déjà utilisé.");

  let author;
  try {
    author = await authorService.insert({
      name: d.name,
      slug,
      bio: d.bio || null,
      job_title: d.jobTitle || null,
      expertise: d.expertise || null,
      avatar_media_id: d.avatarMediaId || null,
      same_as: d.sameAs || null,
      meta_title: d.metaTitle || null,
      meta_description: d.metaDescription || null,
      canonical_url: d.canonicalUrl || null,
      noindex: d.noindex,
      is_active: d.isActive,
    });
  } catch (err) {
    if (isUniqueViolation(err)) return fail("conflict", "Slug déjà utilisé.");
    throw err;
  }

  await bus.emit("author.created", { authorId: author.id, slug: author.slug }, { actorUserId });
  return ok({ authorId: author.id, slug: author.slug });
});

// Explicit UPDATE schema — every field `.optional()`, NO `.default()` (the .partial()
// lesson: a re-applied default clobbers an omitted column).
export const updateAuthorSchema = z.object({
  authorId: z.string().uuid(),
  name: z.string().trim().min(1).max(160).optional(),
  slug: slugSchema.optional(),
  bio: z.string().nullable().optional(),
  jobTitle: z.string().trim().max(160).nullable().optional(),
  expertise: z.string().nullable().optional(),
  avatarMediaId: z.string().nullable().optional(),
  sameAs: z.string().nullable().optional(),
  metaTitle: metaTitle.nullable().optional(),
  metaDescription: metaDescription.nullable().optional(),
  canonicalUrl: canonicalUrl.nullable().optional(),
  noindex: z.boolean().optional(),
  isActive: z.boolean().optional(),
});

export const updateAuthorWorkflow = workflow<
  [z.input<typeof updateAuthorSchema>, { actorUserId: string }],
  { authorId: string }
>("author.update", async (input, { actorUserId }) => {
  const parsed = updateAuthorSchema.safeParse(input);
  if (!parsed.success) return fail("validation", "Validation échouée");
  const d = parsed.data;

  const existing = await authorService.findById(d.authorId);
  if (!existing) return fail("not_found", "Auteur introuvable.");

  const patch: Record<string, unknown> = {};
  const changed: string[] = [];
  const set = (key: string, value: unknown) => {
    patch[key] = value;
    changed.push(key);
  };

  if (d.name !== undefined && d.name !== existing.name) set("name", d.name);
  if (d.slug !== undefined && d.slug !== existing.slug) {
    const dup = await authorService.findBySlugAny(d.slug);
    if (dup && dup.id !== existing.id) return fail("conflict", "Slug déjà utilisé.");
    set("slug", d.slug);
  }
  if (d.bio !== undefined) set("bio", d.bio || null);
  if (d.jobTitle !== undefined) set("job_title", d.jobTitle || null);
  if (d.expertise !== undefined) set("expertise", d.expertise || null);
  if (d.avatarMediaId !== undefined) set("avatar_media_id", d.avatarMediaId || null);
  if (d.sameAs !== undefined) set("same_as", d.sameAs || null);
  if (d.metaTitle !== undefined) set("meta_title", d.metaTitle || null);
  if (d.metaDescription !== undefined) set("meta_description", d.metaDescription || null);
  if (d.canonicalUrl !== undefined) set("canonical_url", d.canonicalUrl || null);
  if (d.noindex !== undefined && d.noindex !== existing.noindex) set("noindex", d.noindex);
  if (d.isActive !== undefined && d.isActive !== existing.is_active) set("is_active", d.isActive);

  if (Object.keys(patch).length > 0) {
    try {
      await authorService.update(existing.id, patch);
    } catch (err) {
      if (isUniqueViolation(err)) return fail("conflict", "Slug déjà utilisé.");
      throw err;
    }
    await bus.emit("author.updated", { authorId: existing.id, changedFields: changed }, { actorUserId });
  }
  return ok({ authorId: existing.id });
});

export const deleteAuthorWorkflow = workflow<
  [{ authorId: string }, { actorUserId: string }],
  { authorId: string }
>("author.delete", async ({ authorId }, { actorUserId }) => {
  // SOFT delete (archive): keeps the row so already-published article bylines pointing at
  // this Person @id survive. Existence check first so a stale click returns a clean
  // not_found. Live post `author_id` links stay set but resolve to the fallback byline
  // (findByIds is active-only), and the profile can be restored (restoreAuthorWorkflow).
  const existing = await authorService.findById(authorId);
  if (!existing) return fail("not_found", "Auteur introuvable.");
  await authorService.softDelete(authorId);
  await bus.emit("author.deleted", { authorId }, { actorUserId });
  return ok({ authorId });
});

export const restoreAuthorWorkflow = workflow<
  [{ authorId: string }, { actorUserId: string }],
  { authorId: string }
>("author.restore", async ({ authorId }, { actorUserId }) => {
  // Only matches a SOFT-DELETED row, so a null result means the id is unknown or already
  // active — either way nothing to restore. Reuses `author.updated` (an un-archive is a
  // mutation of the profile's visibility) so the byline-cache buster stays symmetric.
  const restored = await authorService.restore(authorId);
  if (!restored) return fail("not_found", "Auteur archivé introuvable.");
  await bus.emit("author.updated", { authorId, changedFields: ["deleted_at"] }, { actorUserId });
  return ok({ authorId });
});
