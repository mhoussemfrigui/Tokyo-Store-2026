"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";

import { workflows } from "@/workflows";
import { getCurrentUser } from "@/lib/auth/session";
import { checkRateLimit } from "@/lib/rate-limit";
import { getClientIp } from "@/lib/client-ip";
import { isUuid } from "@/lib/utils/uuid";
import { blogService } from "@/modules/blog/service";
import { getBlogCommentsConfig } from "@/lib/blog/comments-config";
import { getApprovedThread, type CommentNode } from "@/lib/blog/comment-thread";
import { type ActionState } from "@/lib/actions/types";

/**
 * Submit (or edit) a reader comment + optional star rating on a blog article.
 * ACCOUNT-ONLY. Rate-limited per user + per IP like our other public-write
 * endpoints (reviews / newsletter). The workflow enforces the enabled / ratings /
 * moderation policy and the one-comment-per-reader rule.
 */
export async function submitBlogCommentAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  const user = await getCurrentUser();
  if (!user) {
    return { ok: false, error: "auth", message: "Connectez-vous pour commenter." };
  }

  const h = await headers();
  const ip = getClientIp(h);
  const userRl = await checkRateLimit({ bucket: `blogcomment:user:${user.id}`, max: 5, windowSeconds: 60 });
  const ipRl = await checkRateLimit({ bucket: `blogcomment:ip:${ip ?? "anon"}`, max: 10, windowSeconds: 60 });
  if (!userRl.ok || !ipRl.ok) {
    return { ok: false, error: "rate_limited", message: "Trop de commentaires envoyés. Réessayez dans un instant." };
  }

  const authorName =
    ((user.name ?? "").trim() || (user.email ?? "").split("@")[0] || "Client").slice(0, 80);
  const ratingRaw = Number(formData.get("rating") ?? 0);
  const rating = ratingRaw >= 1 && ratingRaw <= 5 ? ratingRaw : null;
  const slug = String(formData.get("slug") ?? "").trim();
  const parentRaw = String(formData.get("parentId") ?? "").trim();
  const parentId = isUuid(parentRaw) ? parentRaw : null;

  const res = await workflows.blogComments.submit(
    {
      postId: String(formData.get("postId") ?? ""),
      parentId,
      body: String(formData.get("body") ?? ""),
      rating,
    },
    { userId: user.id, authorName },
  );
  if (!res.ok) return { ok: false, error: res.error, message: res.message };
  if (slug) revalidatePath(`/blog/${slug}`);
  const isReply = parentId !== null;
  return {
    ok: true,
    message:
      res.data.status === "approved"
        ? isReply
          ? "Merci ! Votre réponse est publiée."
          : "Merci ! Votre commentaire est publié."
        : isReply
          ? "Merci ! Votre réponse sera publiée après validation."
          : "Merci ! Votre commentaire sera publié après validation.",
  };
}

/**
 * Fetch the NEXT page of a post's approved comment thread (top-level comments +
 * their replies) for the storefront « Charger plus » append. Read-only + public
 * (gated by the same enabled flag); returns the serializable node shape the client
 * already renders, so appending is a plain concat.
 */
export async function loadMoreBlogCommentsAction(
  postId: string,
  cursor: string,
): Promise<{ ok: true; nodes: CommentNode[]; nextCursor: string | null } | { ok: false }> {
  // The keyset cursor is the last top-level comment's UUID id (see
  // listApprovedTopLevel) — reject a malformed one up front.
  if (!isUuid(postId) || !isUuid(cursor)) return { ok: false };
  try {
    const cfg = await getBlogCommentsConfig();
    if (!cfg.enabled) return { ok: false };
    // Gate on a live, PUBLISHED post — the article page 404s for an unpublished /
    // soft-deleted post, so its comment thread must not be loadable here either
    // (findPostById already excludes soft-deleted).
    const post = await blogService.findPostById(postId);
    if (!post || !post.is_published) return { ok: false };
    const { nodes, nextCursor } = await getApprovedThread(postId, { cursor });
    return { ok: true, nodes, nextCursor };
  } catch {
    return { ok: false };
  }
}
