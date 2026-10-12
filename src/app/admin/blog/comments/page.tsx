import type { Metadata } from "next";

import { requirePermission } from "@/lib/auth/session";
import { blogCommentService } from "@/modules/blog/comments";
import { getBlogCommentsConfig } from "@/lib/blog/comments-config";
import { type BlogCommentStatus } from "@/modules/blog/schema";
import { BlogCommentsPanel } from "./comments-panel";

export const metadata: Metadata = { title: "Commentaires" };

const PAGE_SIZE = 20;

export default async function BlogCommentsAdmin({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; page?: string }>;
}) {
  await requirePermission("blog_comments", "view");
  const sp = await searchParams;
  // Default queue = « En attente »; `all` clears the filter.
  const filter: "all" | BlogCommentStatus =
    sp.status === "approved" || sp.status === "rejected" || sp.status === "all"
      ? sp.status
      : "pending";
  const status = filter === "all" ? undefined : filter;
  // Floored so a non-integer ?page= can't produce a fractional OFFSET.
  const requestedPage = Math.max(1, Math.floor(Number(sp.page)) || 1);

  // Count first so the requested page can be CLAMPED to the real range before the
  // row fetch — otherwise moderating the last row on a page (total drops onto a
  // page boundary) would strand the operator on an empty over-range page with the
  // nav hidden and a false « aucun commentaire » state.
  const total = await blogCommentService.countForAdmin(status);
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.min(requestedPage, totalPages);

  const [rows, counts, config] = await Promise.all([
    blogCommentService.listForAdmin({ status, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE }),
    blogCommentService.countByStatus(),
    getBlogCommentsConfig(),
  ]);

  return (
    <BlogCommentsPanel
      comments={rows.map((r) => ({
        id: r.id,
        authorName: r.author_name,
        body: r.body,
        rating: r.rating,
        status: r.status,
        createdAt: r.created_at.toISOString(),
        postSlug: r.postSlug,
        postTitle: r.postTitle,
        parentAuthorName: r.parentAuthorName,
      }))}
      counts={counts}
      config={config}
      status={filter}
      page={page}
      pageSize={PAGE_SIZE}
      total={total}
    />
  );
}
