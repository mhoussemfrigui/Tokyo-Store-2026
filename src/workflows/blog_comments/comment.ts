import "server-only";

import { z } from "zod";

import { blogCommentService } from "@/modules/blog/comments";
import { blogService } from "@/modules/blog/service";
import { getBlogCommentsConfig } from "@/lib/blog/comments-config";
import { bus } from "@/events/bus";
import { isUniqueViolation } from "@/lib/db/pg-errors";
import { fail, ok, workflow } from "../shared";
import { BLOG_COMMENT_STATUSES } from "@/modules/blog/schema";

export const submitBlogCommentSchema = z.object({
  postId: z.string().uuid(),
  /** Set = a reply to this comment; omitted/null = a new top-level comment. */
  parentId: z.string().uuid().nullable().optional(),
  body: z.string().trim().min(2).max(10000),
  rating: z.number().int().min(1).max(5).nullable().optional(),
});

/**
 * Reader submits (or edits) a comment or reply on a published post. Account-only —
 * the caller passes the resolved userId + display-name snapshot. Config-gated
 * (enabled / ratings / pre-moderation).
 *
 * TOP-LEVEL (no parentId): one live comment per reader per post — a resubmit
 * UPDATES the existing row (and re-enters moderation when required); may carry a
 * rating. REPLY (parentId): unlimited, never rated, always a fresh row; the parent
 * must be an APPROVED, non-deleted comment on the SAME post, and a reply to a reply
 * is flattened onto its top-level ancestor (one-level thread).
 */
export const submitBlogCommentWorkflow = workflow<
  [z.input<typeof submitBlogCommentSchema>, { userId: string; authorName: string }],
  { commentId: string; status: string }
>("blog.comment.submit", async (input, { userId, authorName }) => {
  const cfg = await getBlogCommentsConfig();
  if (!cfg.enabled) return fail("forbidden", "Les commentaires sont désactivés.");

  const parsed = submitBlogCommentSchema.safeParse(input);
  if (!parsed.success) return fail("validation", "Commentaire invalide.");
  const d = parsed.data;
  if (d.body.length > cfg.maxLength)
    return fail("validation", `Commentaire trop long (max ${cfg.maxLength} caractères).`);

  const post = await blogService.findPostById(d.postId);
  if (!post || !post.is_published || post.deleted_at) return fail("not_found", "Article introuvable.");

  // Resolve the reply target (if any): must be a live, approved comment on this
  // post. Flatten a reply-to-reply onto the top-level ancestor so the thread never
  // nests past one level, whatever the client sends.
  let parentId: string | null = null;
  if (d.parentId) {
    const parent = await blogCommentService.findById(d.parentId);
    if (!parent || parent.deleted_at || parent.post_id !== d.postId || parent.status !== "approved")
      return fail("not_found", "Commentaire parent introuvable.");
    parentId = parent.parent_id ?? parent.id;
    // When flattening a reply-to-a-reply onto its ancestor, the DIRECT parent being
    // approved doesn't prove the ancestor still is — re-check it so a reply can't
    // attach to a top-level comment that was since rejected / soft-deleted (which
    // would create a counted-but-never-rendered orphan).
    if (parent.parent_id) {
      const ancestor = await blogCommentService.findById(parent.parent_id);
      if (!ancestor || ancestor.deleted_at || ancestor.post_id !== d.postId || ancestor.status !== "approved")
        return fail("not_found", "Commentaire parent introuvable.");
    }
  }

  const status = cfg.requireApproval ? "pending" : "approved";
  const name = (authorName.trim() || "Client").slice(0, 80);
  // Replies never carry a rating (DB CHECK); ratings also require the feature on.
  const rating = parentId === null && cfg.ratingsEnabled ? d.rating ?? null : null;

  let row;
  try {
    if (parentId !== null) {
      // Reply — always a new row, no one-per-reader constraint.
      row = await blogCommentService.insert({
        postId: d.postId,
        parentId,
        userId,
        authorName: name,
        body: d.body,
        rating: null,
        status,
      });
    } else {
      const existing = await blogCommentService.findByUserAndPost(userId, d.postId);
      row = existing
        ? await blogCommentService.updateOwn(existing.id, { authorName: name, body: d.body, rating, status })
        : await blogCommentService.insert({
            postId: d.postId,
            parentId: null,
            userId,
            authorName: name,
            body: d.body,
            rating,
            status,
          });
    }
  } catch (err) {
    // Lost the one-per-reader race against a concurrent submit — clean conflict.
    if (isUniqueViolation(err)) return fail("conflict", "Vous avez déjà commenté cet article.");
    throw err;
  }
  if (!row) return fail("not_found", "Commentaire introuvable.");

  await bus.emit(
    "blog.comment.submitted",
    { commentId: row.id, postId: d.postId, status: row.status },
    { actorUserId: userId },
  );
  return ok({ commentId: row.id, status: row.status });
});

export const setBlogCommentStatusSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(BLOG_COMMENT_STATUSES),
});

/** Admin moderation — approve / reject a comment. No-op when already in state. */
export const setBlogCommentStatusWorkflow = workflow<
  [z.input<typeof setBlogCommentStatusSchema>, { actorUserId: string }],
  { commentId: string }
>("blog.comment.set_status", async (input, { actorUserId }) => {
  const parsed = setBlogCommentStatusSchema.safeParse(input);
  if (!parsed.success) return fail("validation", "Validation échouée");
  const existing = await blogCommentService.findById(parsed.data.id);
  if (!existing || existing.deleted_at) return fail("not_found", "Commentaire introuvable.");
  if (existing.status === parsed.data.status) return ok({ commentId: existing.id });
  // Approving a REPLY whose top-level parent isn't approved would be a silent
  // no-op on the storefront (the thread only shows replies under a visible
  // parent) — tell the moderator to approve the parent first instead.
  if (parsed.data.status === "approved" && existing.parent_id) {
    const parent = await blogCommentService.findById(existing.parent_id);
    if (!parent || parent.deleted_at || parent.status !== "approved")
      return fail("conflict", "Approuvez d'abord le commentaire parent.");
  }
  const row = await blogCommentService.setStatus(parsed.data.id, parsed.data.status);
  if (!row) return fail("not_found", "Commentaire introuvable.");
  await bus.emit(
    "blog.comment.moderated",
    { commentId: row.id, postId: row.post_id, status: row.status },
    { actorUserId },
  );
  return ok({ commentId: row.id });
});

export const deleteBlogCommentWorkflow = workflow<
  [{ id: string }, { actorUserId: string }],
  { commentId: string }
>("blog.comment.delete", async ({ id }, { actorUserId }) => {
  const existing = await blogCommentService.findById(id);
  if (!existing || existing.deleted_at) return fail("not_found", "Commentaire introuvable.");
  await blogCommentService.softDelete(id);
  await bus.emit("blog.comment.deleted", { commentId: id, postId: existing.post_id }, { actorUserId });
  return ok({ commentId: id });
});
