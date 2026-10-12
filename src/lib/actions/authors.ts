"use server";

import { revalidatePath } from "next/cache";

import { workflows } from "@/workflows";
import { requirePermission } from "@/lib/auth/session";
import { type ActionState } from "@/lib/actions/types";
import { CACHE_TAGS } from "@/lib/cache/tags";
import { bustCacheTag } from "@/lib/cache/revalidate";
import { isUuid } from "@/lib/utils/uuid";

/**
 * Editing/removing an author changes the byline (name/avatar/jobTitle) EMBEDDED
 * in the cached blog listing (`listPublishedPosts` is `"use cache"` tagged
 * blog:posts). Bust it so a rename/deactivate/delete reflects on /blog + category
 * listings without waiting for the cacheLife floor.
 */
function bustBlogListings() {
  bustCacheTag(CACHE_TAGS.blogPosts);
}

export async function createAuthorAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  const session = await requirePermission("blog_authors", "create");
  const result = await workflows.authors.create(
    {
      name: String(formData.get("name") ?? ""),
      slug: optional(formData, "slug"),
      bio: optional(formData, "bio"),
      jobTitle: optional(formData, "jobTitle"),
      expertise: optional(formData, "expertise"),
      avatarMediaId: optionalUuid(formData, "avatarMediaId"),
      sameAs: optional(formData, "sameAs"),
      metaTitle: optional(formData, "metaTitle"),
      metaDescription: optional(formData, "metaDescription"),
      canonicalUrl: optional(formData, "canonicalUrl"),
      noindex: formData.get("noindex") === "on",
      isActive: formData.get("isActive") === "on",
    },
    { actorUserId: session.user.id },
  );
  if (!result.ok) return { ok: false, error: result.error, message: result.message };
  revalidatePath("/admin/blog/authors");
  revalidatePath(`/auteur/${result.data.slug}`);
  return { ok: true, message: "Auteur créé.", id: result.data.authorId };
}

export async function updateAuthorAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  const session = await requirePermission("blog_authors", "update");
  const authorId = optional(formData, "authorId");
  if (!authorId) return { ok: false, error: "validation", message: "ID requis." };
  const result = await workflows.authors.update(
    {
      authorId,
      name: optional(formData, "name"),
      slug: optional(formData, "slug"),
      bio: formData.has("bio") ? (optional(formData, "bio") ?? "") : undefined,
      jobTitle: formData.has("jobTitle") ? (optional(formData, "jobTitle") ?? "") : undefined,
      expertise: formData.has("expertise") ? (optional(formData, "expertise") ?? "") : undefined,
      avatarMediaId: nullableUuid(formData, "avatarMediaId"),
      sameAs: formData.has("sameAs") ? (optional(formData, "sameAs") ?? "") : undefined,
      metaTitle: formData.has("metaTitle") ? (optional(formData, "metaTitle") ?? "") : undefined,
      metaDescription: formData.has("metaDescription")
        ? (optional(formData, "metaDescription") ?? "")
        : undefined,
      canonicalUrl: formData.has("canonicalUrl") ? (optional(formData, "canonicalUrl") ?? "") : undefined,
      noindex: formData.get("noindex") === "on",
      isActive: formData.get("isActive") === "on",
    },
    { actorUserId: session.user.id },
  );
  if (!result.ok) return { ok: false, error: result.error, message: result.message };
  revalidatePath("/admin/blog/authors");
  // Bust the author's public archive (slug may have changed → bust the posted slug, cheap).
  const slug = optional(formData, "slug");
  if (slug) revalidatePath(`/auteur/${slug}`);
  bustBlogListings();
  return { ok: true, message: "Auteur mis à jour.", id: authorId };
}

export async function deleteAuthorAction(authorId: string): Promise<ActionState> {
  const session = await requirePermission("blog_authors", "delete");
  const result = await workflows.authors.delete({ authorId }, { actorUserId: session.user.id });
  if (!result.ok) return { ok: false, error: result.error, message: result.message };
  revalidatePath("/admin/blog/authors");
  // Archiving an author drops their byline from a fresh render; bust the cached blog
  // listing so /blog stops showing the removed name/avatar before the cacheLife floor.
  bustBlogListings();
  return { ok: true };
}

export async function restoreAuthorAction(authorId: string): Promise<ActionState> {
  const session = await requirePermission("blog_authors", "update");
  const result = await workflows.authors.restore({ authorId }, { actorUserId: session.user.id });
  if (!result.ok) return { ok: false, error: result.error, message: result.message };
  revalidatePath("/admin/blog/authors");
  // The byline reappears on the author's live posts → bust the cached blog listing.
  bustBlogListings();
  return { ok: true, message: "Auteur restauré." };
}

function optional(form: FormData, key: string): string | undefined {
  const v = form.get(key);
  if (v === null) return undefined;
  const s = String(v).trim();
  return s.length ? s : undefined;
}
function optionalUuid(form: FormData, key: string): string | undefined {
  const v = optional(form, key);
  return v && isUuid(v) ? v : undefined;
}
/**
 * Tri-state for a clearable FK/media field: undefined = field absent (leave
 * unchanged), null = present-but-blank (CLEAR it), or a valid uuid.
 */
function nullableUuid(form: FormData, key: string): string | null | undefined {
  if (!form.has(key)) return undefined;
  const v = optional(form, key);
  if (v === undefined) return null;
  return isUuid(v) ? v : null;
}
