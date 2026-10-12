import "server-only";

import { blogCommentService } from "@/modules/blog/comments";

/** A reply in a comment thread (never carries a rating). */
export type ReplyNode = {
  id: string;
  authorName: string;
  body: string;
  createdAt: string;
};

/** A top-level comment + its (chronological) approved replies. */
export type CommentNode = ReplyNode & {
  rating: number | null;
  replies: ReplyNode[];
};

/** Default top-level comments per thread page (the « Charger plus » step). */
export const COMMENT_PAGE_SIZE = 10;

const toReply = (c: { id: string; author_name: string; body: string; created_at: Date }): ReplyNode => ({
  id: c.id,
  authorName: c.author_name,
  body: c.body,
  createdAt: c.created_at.toISOString(),
});

/**
 * One keyset page of a post's APPROVED comment thread: top-level comments
 * (newest first) each hydrated with their approved replies (oldest first), plus a
 * nextCursor for the next page. Shared by the article server component (page 1)
 * and the « Charger plus » server action (subsequent pages) so both build the
 * exact same shape.
 */
export async function getApprovedThread(
  postId: string,
  opts: { cursor?: string; limit?: number } = {},
): Promise<{ nodes: CommentNode[]; nextCursor: string | null }> {
  const { items, nextCursor } = await blogCommentService.listApprovedTopLevel(postId, {
    limit: opts.limit ?? COMMENT_PAGE_SIZE,
    cursor: opts.cursor,
  });
  const replies = items.length
    ? await blogCommentService.listApprovedRepliesFor(items.map((c) => c.id))
    : [];
  const byParent = new Map<string, ReplyNode[]>();
  for (const r of replies) {
    if (!r.parent_id) continue;
    const arr = byParent.get(r.parent_id) ?? [];
    arr.push(toReply(r));
    byParent.set(r.parent_id, arr);
  }
  const nodes: CommentNode[] = items.map((c) => ({
    ...toReply(c),
    rating: c.rating,
    replies: byParent.get(c.id) ?? [],
  }));
  return { nodes, nextCursor };
}
