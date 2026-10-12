import type { Metadata } from "next";
import Link from "next/link";
import { ChevronLeft } from "lucide-react";

import { requirePermission } from "@/lib/auth/session";
import { blogService } from "@/modules/blog/service";
import { authorService } from "@/modules/authors/service";
import { BlogPostForm } from "@/components/admin/blog-post-form";

export const metadata: Metadata = { title: "Nouvel article" };

/**
 * Full create page — the SAME FormTabs form as edit (cover image + rich body +
 * SEO + tags) so an author sets everything in one pass instead of the old
 * cramped inline quick-create. On success the form redirects to the new post's
 * edit page.
 */
export default async function BlogPostCreatePage() {
  await requirePermission("blog_posts", "create");
  const [categories, tags, authors] = await Promise.all([
    blogService.listCategories(),
    blogService.listTags(),
    authorService.listActive(),
  ]);

  return (
    <div className="space-y-6">
      <div>
        <Link
          href="/admin/blog/posts"
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="h-3 w-3" /> Retour aux articles
        </Link>
        <h1 className="mt-2 text-[26px] font-black tracking-[-0.02em] text-foreground sm:text-[30px]">
          Nouvel article
        </h1>
      </div>

      <BlogPostForm
        mode="create"
        successHref="/admin/blog/posts"
        categories={categories.map((c) => ({ id: c.id, name: c.name }))}
        authors={authors.map((a) => ({ id: a.id, name: a.name }))}
        tags={tags.map((t) => ({ id: t.id, name: t.name }))}
        initialProducts={[]}
      />
    </div>
  );
}
