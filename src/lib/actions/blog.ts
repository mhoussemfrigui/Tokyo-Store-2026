"use server";

import { revalidatePath } from "next/cache";

import { workflows } from "@/workflows";
import { blogService } from "@/modules/blog/service";
import { requirePermission } from "@/lib/auth/session";
import { isUuid } from "@/lib/utils/uuid";
import { type ActionState } from "@/lib/actions/types";

export async function createBlogCategoryAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  const session = await requirePermission("blog_cats", "create");
  const result = await workflows.blog.createCategory(
    {
      name: String(formData.get("name") ?? ""),
      slug: optional(formData, "slug"),
      description: optional(formData, "description"),
      displayOrder: optionalInt(formData, "displayOrder") ?? 0,
      isActive: formData.get("isActive") === "on",
    },
    { actorUserId: session.user.id },
  );
  if (!result.ok) return { ok: false, error: result.error, message: result.message };
  revalidatePath("/admin/blog/categories");
  revalidatePath("/blog");
  return { ok: true, message: "Catégorie créée." };
}

export async function updateBlogCategoryAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  const session = await requirePermission("blog_cats", "update");
  const categoryId = optional(formData, "categoryId");
  if (!categoryId) return { ok: false, error: "validation", message: "ID requis." };
  const result = await workflows.blog.updateCategory(
    {
      categoryId,
      name: optional(formData, "name"),
      slug: optional(formData, "slug"),
      description: formData.has("description")
        ? (optional(formData, "description") ?? "")
        : undefined,
      displayOrder: optionalInt(formData, "displayOrder"),
      isActive: formData.get("isActive") === "on",
      metaTitle: formData.has("metaTitle") ? (optional(formData, "metaTitle") ?? "") : undefined,
      metaDescription: formData.has("metaDescription")
        ? (optional(formData, "metaDescription") ?? "")
        : undefined,
      noindex: formData.get("noindex") === "on",
    },
    { actorUserId: session.user.id },
  );
  if (!result.ok) return { ok: false, error: result.error, message: result.message };
  revalidatePath("/admin/blog/categories");
  revalidatePath("/blog");
  revalidatePath(`/blog/${optional(formData, "slug") ?? ""}`);
  return { ok: true, message: "Catégorie mise à jour.", id: categoryId };
}

export async function deleteBlogCategoryAction(categoryId: string): Promise<ActionState> {
  const session = await requirePermission("blog_cats", "delete");
  const result = await workflows.blog.deleteCategory({ categoryId }, { actorUserId: session.user.id });
  if (!result.ok) return { ok: false, error: result.error, message: result.message };
  revalidatePath("/admin/blog/categories");
  revalidatePath("/blog");
  return { ok: true, message: "Catégorie supprimée." };
}

export async function createBlogPostAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  const session = await requirePermission("blog_posts", "create");
  const result = await workflows.blog.createPost(
    {
      title: String(formData.get("title") ?? ""),
      slug: optional(formData, "slug"),
      excerpt: optional(formData, "excerpt"),
      body: String(formData.get("body") ?? ""),
      categoryId: optionalUuid(formData, "categoryId"),
      authorId: optionalUuid(formData, "authorId"),
      featuredImageMediaId: optionalUuid(formData, "featuredImageMediaId"),
      readingMinutes: optionalInt(formData, "readingMinutes"),
      metaTitle: optional(formData, "metaTitle"),
      metaDescription: optional(formData, "metaDescription"),
      publish: formData.get("publish") === "on",
      tagIds: pickAll(formData, "tagIds"),
    },
    { actorUserId: session.user.id },
  );
  if (!result.ok) return { ok: false, error: result.error, message: result.message };
  // Persist the « Produits cités » links — mirrors the tagIds wiring; the picker
  // emits one `productIds` hidden input per pick (ordered). setPostProducts
  // filters to valid uuids internally; an empty list clears the links.
  await blogService.setPostProducts(result.data.postId, pickAll(formData, "productIds"));
  revalidatePath("/admin/blog/posts");
  revalidatePath("/blog");
  return { ok: true, message: "Article créé.", id: result.data.postId };
}

export async function updateBlogPostAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  const session = await requirePermission("blog_posts", "update");
  const postId = optional(formData, "postId");
  if (!postId) return { ok: false, error: "validation", message: "ID requis." };
  const result = await workflows.blog.updatePost(
    {
      postId,
      title: optional(formData, "title"),
      slug: optional(formData, "slug"),
      excerpt: formData.has("excerpt")
        ? (optional(formData, "excerpt") ?? "")
        : undefined,
      body: optional(formData, "body"),
      categoryId: nullableUuid(formData, "categoryId"),
      authorId: nullableUuid(formData, "authorId"),
      featuredImageMediaId: nullableUuid(formData, "featuredImageMediaId"),
      readingMinutes: optionalInt(formData, "readingMinutes"),
      metaTitle: formData.has("metaTitle")
        ? (optional(formData, "metaTitle") ?? "")
        : undefined,
      metaDescription: formData.has("metaDescription")
        ? (optional(formData, "metaDescription") ?? "")
        : undefined,
      publish: formData.get("publish") === "on",
      tagIds: pickAll(formData, "tagIds"),
    },
    { actorUserId: session.user.id },
  );
  if (!result.ok) return { ok: false, error: result.error, message: result.message };
  // Replace the « Produits cités » links — mirrors the tagIds wiring; the picker
  // emits one `productIds` hidden input per pick (ordered). setPostProducts
  // filters to valid uuids internally; an empty list clears the links.
  await blogService.setPostProducts(postId, pickAll(formData, "productIds"));
  revalidatePath("/admin/blog/posts");
  revalidatePath("/blog");
  return { ok: true, message: "Article mis à jour.", id: postId };
}

export async function togglePostPublishAction(
  postId: string,
  publish: boolean,
): Promise<ActionState> {
  const session = await requirePermission("blog_posts", "update");
  const result = await workflows.blog.togglePostPublish(
    { postId, publish },
    { actorUserId: session.user.id },
  );
  if (!result.ok) return { ok: false, error: result.error, message: result.message };
  revalidatePath("/admin/blog/posts");
  revalidatePath("/blog");
  return { ok: true, message: publish ? "Article publié." : "Article dépublié." };
}

export async function deleteBlogPostAction(postId: string): Promise<ActionState> {
  const session = await requirePermission("blog_posts", "delete");
  const result = await workflows.blog.deletePost({ postId }, { actorUserId: session.user.id });
  if (!result.ok) return { ok: false, error: result.error, message: result.message };
  revalidatePath("/admin/blog/posts");
  revalidatePath("/blog");
  return { ok: true, message: "Article supprimé." };
}

export async function restoreBlogPostAction(postId: string): Promise<ActionState> {
  const session = await requirePermission("blog_posts", "update");
  const result = await workflows.blog.restorePost({ postId }, { actorUserId: session.user.id });
  if (!result.ok) return { ok: false, error: result.error, message: result.message };
  revalidatePath("/admin/blog/posts");
  revalidatePath("/blog");
  return { ok: true, message: "Article restauré." };
}

// ─────────────────────────────────────────────────────── tags
export async function createTagAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  const session = await requirePermission("blog_tags", "create");
  const result = await workflows.blog.createTag(
    {
      name: String(formData.get("name") ?? ""),
      slug: optional(formData, "slug"),
    },
    { actorUserId: session.user.id },
  );
  if (!result.ok) return { ok: false, error: result.error, message: result.message };
  revalidatePath("/admin/blog/tags");
  revalidatePath("/blog");
  return { ok: true, message: "Tag créé.", id: result.data.tagId };
}

export async function updateTagAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  const session = await requirePermission("blog_tags", "update");
  const tagId = optional(formData, "tagId");
  if (!tagId) return { ok: false, error: "validation", message: "ID requis." };
  const result = await workflows.blog.updateTag(
    {
      tagId,
      name: optional(formData, "name"),
      slug: optional(formData, "slug"),
    },
    { actorUserId: session.user.id },
  );
  if (!result.ok) return { ok: false, error: result.error, message: result.message };
  revalidatePath("/admin/blog/tags");
  revalidatePath("/blog");
  return { ok: true, message: "Tag mis à jour.", id: tagId };
}

export async function deleteTagAction(tagId: string): Promise<ActionState> {
  const session = await requirePermission("blog_tags", "delete");
  const result = await workflows.blog.deleteTag({ tagId }, { actorUserId: session.user.id });
  if (!result.ok) return { ok: false, error: result.error, message: result.message };
  revalidatePath("/admin/blog/tags");
  revalidatePath("/blog");
  return { ok: true, message: "Tag supprimé." };
}

function optional(form: FormData, key: string): string | undefined {
  const v = form.get(key);
  if (v === null) return undefined;
  const s = String(v).trim();
  return s.length ? s : undefined;
}
function optionalInt(form: FormData, key: string): number | undefined {
  const v = optional(form, key);
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}
function optionalUuid(form: FormData, key: string): string | undefined {
  const v = optional(form, key);
  return v && isUuid(v) ? v : undefined;
}
/**
 * Tri-state for a clearable FK field: undefined = field absent (leave
 * unchanged), null = present-but-blank (CLEAR it), or a valid uuid. Lets an
 * edit form un-set the category / cover image, which `optionalUuid` (string |
 * undefined) could never express.
 */
function nullableUuid(form: FormData, key: string): string | null | undefined {
  if (!form.has(key)) return undefined;
  const v = optional(form, key);
  if (v === undefined) return null;
  return isUuid(v) ? v : null;
}
function pickAll(form: FormData, key: string): string[] {
  return form.getAll(key).map((v) => String(v).trim()).filter(Boolean);
}
