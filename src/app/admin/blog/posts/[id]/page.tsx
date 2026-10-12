import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft } from "lucide-react";

import { requirePermission } from "@/lib/auth/session";
import { blogService } from "@/modules/blog/service";
import { authorService } from "@/modules/authors/service";
import { BlogPostForm } from "@/components/admin/blog-post-form";
import { resolveRelatedProductOptionsAction } from "@/lib/actions/related-products";
import { isUuid } from "@/lib/utils/uuid";

export const metadata: Metadata = { title: "Modifier l'article" };

export default async function BlogPostEditPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  await requirePermission("blog_posts", "view");
  if (!isUuid(id)) notFound();
  const post = await blogService.findPostById(id);
  if (!post) notFound();

  const [categories, allTags, currentTags, authors, citedProductIds] = await Promise.all([
    // Admin listing (incl. inactive) so a post already filed under a
    // deactivated category still shows its current category in the dropdown
    // instead of silently vanishing / being reassigned on save.
    blogService.listCategoriesForAdmin(),
    blogService.listTags(),
    blogService.listTagsForPost(post.id),
    authorService.listActive(),
    blogService.listProductIdsForPost(post.id),
  ]);
  // Hydrate the cited-product ids into picker cards — reuse the shared
  // id→card resolver (same as the product form's cross-sell pickers).
  const citedProducts =
    citedProductIds.length > 0
      ? await resolveRelatedProductOptionsAction(citedProductIds)
      : [];

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
          {post.title}
        </h1>
        <p className="mt-1 text-[14px] text-muted-foreground">/{post.slug}</p>
      </div>

      <BlogPostForm
        mode="edit"
        successHref="/admin/blog/posts"
        categories={categories.map((c) => ({
          id: c.id,
          name: c.is_active ? c.name : `${c.name} (inactif)`,
        }))}
        authors={authors.map((a) => ({ id: a.id, name: a.name }))}
        tags={allTags.map((t) => ({ id: t.id, name: t.name }))}
        currentTagIds={currentTags.map((t) => t.id)}
        initialProducts={citedProducts}
        initial={{
          id: post.id,
          slug: post.slug,
          title: post.title,
          excerpt: post.excerpt,
          body: post.body,
          categoryId: post.category_id,
          authorId: post.author_id,
          featuredImageMediaId: post.featured_image_media_id,
          readingMinutes: post.reading_minutes,
          metaTitle: post.meta_title,
          metaDescription: post.meta_description,
          isPublished: post.is_published,
        }}
      />
    </div>
  );
}
