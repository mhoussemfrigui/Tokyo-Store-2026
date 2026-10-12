import type { Metadata } from "next";

import { requirePermission } from "@/lib/auth/session";
import { isUuid } from "@/lib/utils/uuid";
import { blogService } from "@/modules/blog/service";
import { BlogPostsPanel } from "./posts-panel";

export const metadata: Metadata = { title: "Articles blog" };

const PAGE_SIZE = 25;

export default async function BlogPostsAdmin({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string;
    status?: string;
    categoryId?: string;
    page?: string;
  }>;
}) {
  const sp = await searchParams;
  await requirePermission("blog_posts", "view");
  const status = (["draft", "published", "archived"] as const).find((s) => s === sp.status);
  const page = Math.max(1, Number(sp.page ?? "1") || 1);
  const categoryId = sp.categoryId?.trim();

  const [{ items, total }, categories] = await Promise.all([
    // Light projection — the admin table never renders the post body.
    blogService.listPostsLight({
      limit: PAGE_SIZE,
      offset: (page - 1) * PAGE_SIZE,
      search: sp.q?.trim() || undefined,
      status,
      // Only a well-formed uuid reaches the `category_id = $1` filter — a
      // stale/mistyped ?categoryId would otherwise raise Postgres "invalid
      // input syntax for type uuid" and crash the page into the error boundary.
      categoryId: isUuid(categoryId) ? categoryId : undefined,
    }),
    // Admin listing (incl. inactive) so posts filed under a deactivated
    // category remain filterable instead of leaving that filter option missing.
    blogService.listCategoriesForAdmin(),
  ]);

  return (
    <BlogPostsPanel
      posts={items.map((p) => ({
        id: p.id,
        slug: p.slug,
        title: p.title,
        isPublished: p.is_published,
        publishedAt: p.published_at?.toISOString() ?? null,
        categoryId: p.category_id,
      }))}
      categories={categories.map((c) => ({
        id: c.id,
        name: c.is_active ? c.name : `${c.name} (inactif)`,
      }))}
      filters={{
        q: sp.q ?? "",
        status: sp.status ?? "",
        categoryId: isUuid(categoryId) ? categoryId : "",
      }}
      pagination={{ page, pageSize: PAGE_SIZE, total }}
    />
  );
}
