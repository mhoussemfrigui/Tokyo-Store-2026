"use server";

import { revalidatePath } from "next/cache";

import { workflows } from "@/workflows";
import { requirePermission } from "@/lib/auth/session";
import { type ActionState } from "@/lib/actions/types";
import { type BlogCommentStatus } from "@/modules/blog/schema";

export async function setBlogCommentStatusAction(id: string, status: BlogCommentStatus): Promise<ActionState> {
  const session = await requirePermission("blog_comments", "manage");
  const res = await workflows.blogComments.setStatus({ id, status }, { actorUserId: session.user.id });
  if (!res.ok) return { ok: false, error: res.error, message: res.message };
  revalidatePath("/admin/blog/comments");
  revalidatePath("/blog", "layout");
  return { ok: true, message: "Commentaire mis à jour." };
}

export async function deleteBlogCommentAction(id: string): Promise<ActionState> {
  const session = await requirePermission("blog_comments", "delete");
  const res = await workflows.blogComments.delete({ id }, { actorUserId: session.user.id });
  if (!res.ok) return { ok: false, error: res.error, message: res.message };
  revalidatePath("/admin/blog/comments");
  revalidatePath("/blog", "layout");
  return { ok: true, message: "Commentaire supprimé." };
}

/** Save the comments policy (blog.comments.* settings) from the Commentaires tab. */
export async function saveBlogCommentsSettingsAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  const session = await requirePermission("blog_comments", "update");

  const bools = [
    { key: "blog.comments.enabled", on: formData.get("blog.comments.enabled") === "on", label: "Commentaires — activés" },
    { key: "blog.comments.ratings_enabled", on: formData.get("blog.comments.ratings_enabled") === "on", label: "Commentaires — notes (étoiles)" },
    { key: "blog.comments.require_approval", on: formData.get("blog.comments.require_approval") === "on", label: "Commentaires — modération avant publication" },
  ] as const;
  for (const b of bools) {
    const res = await workflows.cms.upsertSetting(
      { key: b.key, value: b.on ? "true" : "false", type: "boolean" as never, groupKey: "blog", label: b.label },
      { actorUserId: session.user.id },
    );
    if (!res.ok) return { ok: false, error: res.error, message: res.message };
  }

  const maxLen = Number(formData.get("blog.comments.max_length") ?? 2000);
  const clamped = Number.isFinite(maxLen) && maxLen >= 200 && maxLen <= 10000 ? Math.round(maxLen) : 2000;
  const r2 = await workflows.cms.upsertSetting(
    { key: "blog.comments.max_length", value: String(clamped), type: "text" as never, groupKey: "blog", label: "Commentaires — longueur maximale" },
    { actorUserId: session.user.id },
  );
  if (!r2.ok) return { ok: false, error: r2.error, message: r2.message };

  revalidatePath("/admin/blog/comments");
  revalidatePath("/blog", "layout");
  return { ok: true, message: "Réglages des commentaires enregistrés." };
}
