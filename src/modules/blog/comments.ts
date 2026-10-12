import "server-only";

import { and, asc, count, desc, eq, inArray, isNull, sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { isUuid } from "@/lib/utils/uuid";
import {
  blog_comments,
  blog_posts,
  type BlogCommentRow,
  type BlogCommentStatus,
} from "./schema";

export type BlogCommentAggregate = { average: number; count: number };

/** A moderation-queue row: the comment + the post + (for replies) the parent author. */
export type AdminBlogCommentRow = BlogCommentRow & {
  postSlug: string;
  postTitle: string;
  parentAuthorName: string | null;
};

/**
 * Reader comments + star ratings on blog posts. Account-only (user_id required).
 * Only `approved` rows surface publicly + feed the AggregateRating; moderation
 * flips status. Comments THREAD one level deep: a top-level comment (parent_id
 * NULL) carries the optional rating and is one-per-reader; replies (parent_id set)
 * are unlimited and never rated. Deletion is SOFT so a removed comment can be
 * audited/restored and the (user_id, post_id) uniqueness frees up for a resubmit.
 */
class BlogCommentService {
  /**
   * Approved, non-deleted TOP-LEVEL comments for a post — newest first, one keyset
   * page (`limit`). Replies are fetched separately (listApprovedRepliesFor) so the
   * page cursor counts comments, not comment+reply rows.
   */
  async listApprovedTopLevel(
    postId: string,
    opts: { limit?: number; cursor?: string } = {},
  ): Promise<{ items: BlogCommentRow[]; nextCursor: string | null }> {
    const limit = Math.min(opts.limit ?? 10, 50);
    const conds = [
      eq(blog_comments.post_id, postId),
      isNull(blog_comments.parent_id),
      eq(blog_comments.status, "approved"),
      isNull(blog_comments.deleted_at),
    ];
    // Keyset on the UUID v7 primary key (time-ordered AND unique). Ordering by id
    // DESC is reverse-chronological for comments (created_at is always now() at
    // insert, never overridden), and the cursor carries the full id — so unlike a
    // created_at cursor (a JS Date floored to ms) it can never skip a row that
    // shares a millisecond with the page boundary. Cursor = the last row's id.
    if (opts.cursor && isUuid(opts.cursor)) {
      conds.push(sql`${blog_comments.id} < ${opts.cursor}::uuid`);
    }
    const rows = await db
      .select()
      .from(blog_comments)
      .where(and(...conds))
      .orderBy(desc(blog_comments.id))
      .limit(limit + 1);
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const last = items[items.length - 1];
    return { items, nextCursor: hasMore && last ? last.id : null };
  }

  /**
   * Approved, non-deleted replies for a set of parent comment ids — OLDEST first
   * (chronological under each parent). One batched query (no N+1); the caller
   * groups by parent_id.
   */
  async listApprovedRepliesFor(parentIds: string[]): Promise<BlogCommentRow[]> {
    const ids = Array.from(new Set(parentIds.filter(isUuid)));
    if (ids.length === 0) return [];
    return db
      .select()
      .from(blog_comments)
      .where(
        and(
          inArray(blog_comments.parent_id, ids),
          eq(blog_comments.status, "approved"),
          isNull(blog_comments.deleted_at),
        ),
      )
      .orderBy(asc(blog_comments.created_at), asc(blog_comments.id));
  }

  /**
   * Total approved, non-deleted comments for a post — the header count. Counts a
   * reply ONLY when its top-level parent is itself approved + live, so the number
   * matches what the thread actually renders (getApprovedThread fetches replies
   * only for visible top-level comments). Otherwise a reply orphaned by a
   * soft-deleted / rejected parent would inflate the count above the visible rows.
   */
  async countApproved(postId: string): Promise<number> {
    const [row] = await db
      .select({ n: count() })
      .from(blog_comments)
      .where(
        and(
          eq(blog_comments.post_id, postId),
          eq(blog_comments.status, "approved"),
          isNull(blog_comments.deleted_at),
          sql`(${blog_comments.parent_id} IS NULL OR EXISTS (
            SELECT 1 FROM ${blog_comments} AS p
            WHERE p.id = ${blog_comments.parent_id}
              AND p.status = 'approved' AND p.deleted_at IS NULL AND p.parent_id IS NULL
          ))`,
        ),
      );
    return Number(row?.n ?? 0);
  }

  /**
   * Average + count over APPROVED, non-deleted TOP-LEVEL comments that carry a
   * rating. Replies never carry a rating (DB CHECK), but the parent_id filter keeps
   * the aggregate explicit + index-friendly.
   */
  async getAggregate(postId: string): Promise<BlogCommentAggregate> {
    const [row] = await db
      .select({ avg: sql<number>`COALESCE(AVG(${blog_comments.rating}), 0)`, n: count() })
      .from(blog_comments)
      .where(
        and(
          eq(blog_comments.post_id, postId),
          isNull(blog_comments.parent_id),
          eq(blog_comments.status, "approved"),
          isNull(blog_comments.deleted_at),
          sql`${blog_comments.rating} IS NOT NULL`,
        ),
      );
    return { average: Number(row?.avg ?? 0), count: Number(row?.n ?? 0) };
  }

  /**
   * The reader's existing LIVE TOP-LEVEL comment on a post (for the one-per-reader
   * upsert). Replies are excluded — a reader may hold one rated comment yet reply
   * freely.
   */
  async findByUserAndPost(userId: string, postId: string): Promise<BlogCommentRow | null> {
    const [row] = await db
      .select()
      .from(blog_comments)
      .where(
        and(
          eq(blog_comments.user_id, userId),
          eq(blog_comments.post_id, postId),
          isNull(blog_comments.parent_id),
          isNull(blog_comments.deleted_at),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  async findById(id: string): Promise<BlogCommentRow | null> {
    const [row] = await db.select().from(blog_comments).where(eq(blog_comments.id, id)).limit(1);
    return row ?? null;
  }

  async insert(input: {
    postId: string;
    parentId: string | null;
    userId: string;
    authorName: string;
    body: string;
    rating: number | null;
    status: BlogCommentStatus;
  }): Promise<BlogCommentRow> {
    const [row] = await db
      .insert(blog_comments)
      .values({
        post_id: input.postId,
        parent_id: input.parentId,
        user_id: input.userId,
        author_name: input.authorName,
        body: input.body,
        rating: input.rating,
        status: input.status,
      })
      .returning();
    return row;
  }

  /** Update the reader's own comment (resubmit) — body/rating/status + author snapshot. */
  async updateOwn(
    id: string,
    patch: { authorName: string; body: string; rating: number | null; status: BlogCommentStatus },
  ): Promise<BlogCommentRow | null> {
    const [row] = await db
      .update(blog_comments)
      .set({
        author_name: patch.authorName,
        body: patch.body,
        rating: patch.rating,
        status: patch.status,
        updated_at: sql`now()`,
      })
      .where(and(eq(blog_comments.id, id), isNull(blog_comments.deleted_at)))
      .returning();
    return row ?? null;
  }

  /** Moderation — approve / reject (pending ↔ approved ↔ rejected). */
  async setStatus(id: string, status: BlogCommentStatus): Promise<BlogCommentRow | null> {
    const [row] = await db
      .update(blog_comments)
      .set({ status, updated_at: sql`now()` })
      .where(and(eq(blog_comments.id, id), isNull(blog_comments.deleted_at)))
      .returning();
    return row ?? null;
  }

  async softDelete(id: string): Promise<void> {
    await db
      .update(blog_comments)
      .set({ deleted_at: new Date(), updated_at: sql`now()` })
      .where(eq(blog_comments.id, id));
  }

  /**
   * Admin moderation queue — optional status filter, newest first, one offset page
   * (`limit`/`offset`), each row carrying its post + (for a reply) the parent
   * comment's author so the panel can show « en réponse à … ».
   */
  async listForAdmin(
    opts: { status?: BlogCommentStatus; limit?: number; offset?: number } = {},
  ): Promise<AdminBlogCommentRow[]> {
    const conds = [isNull(blog_comments.deleted_at)];
    if (opts.status) conds.push(eq(blog_comments.status, opts.status));
    const rows = await db
      .select({
        comment: blog_comments,
        postSlug: blog_posts.slug,
        postTitle: blog_posts.title,
      })
      .from(blog_comments)
      .innerJoin(blog_posts, eq(blog_posts.id, blog_comments.post_id))
      .where(and(...conds))
      .orderBy(desc(blog_comments.created_at))
      .limit(opts.limit ?? 20)
      .offset(opts.offset ?? 0);

    // Resolve parent author names for the replies on this page (one batched query)
    // so the queue can show « réponse à … ».
    const parentIds = Array.from(
      new Set(rows.map((r) => r.comment.parent_id).filter((x): x is string => !!x)),
    );
    const parentNames = new Map<string, string>();
    if (parentIds.length > 0) {
      const parents = await db
        .select({ id: blog_comments.id, authorName: blog_comments.author_name })
        .from(blog_comments)
        .where(inArray(blog_comments.id, parentIds));
      for (const p of parents) parentNames.set(p.id, p.authorName);
    }

    return rows.map((r) => ({
      ...r.comment,
      postSlug: r.postSlug,
      postTitle: r.postTitle,
      parentAuthorName: r.comment.parent_id ? parentNames.get(r.comment.parent_id) ?? null : null,
    }));
  }

  /** Total non-deleted comments for the admin queue (optionally status-filtered) — pagination. */
  async countForAdmin(status?: BlogCommentStatus): Promise<number> {
    const conds = [isNull(blog_comments.deleted_at)];
    if (status) conds.push(eq(blog_comments.status, status));
    const [row] = await db.select({ n: count() }).from(blog_comments).where(and(...conds));
    return Number(row?.n ?? 0);
  }

  /** Non-deleted comment counts per status — the moderation-tab queue badges. */
  async countByStatus(): Promise<Record<BlogCommentStatus, number>> {
    const rows = await db
      .select({ status: blog_comments.status, n: count() })
      .from(blog_comments)
      .where(isNull(blog_comments.deleted_at))
      .groupBy(blog_comments.status);
    const out: Record<BlogCommentStatus, number> = { pending: 0, approved: 0, rejected: 0 };
    for (const r of rows) {
      if (r.status in out) out[r.status as BlogCommentStatus] = Number(r.n);
    }
    return out;
  }
}

export const blogCommentService = new BlogCommentService();
