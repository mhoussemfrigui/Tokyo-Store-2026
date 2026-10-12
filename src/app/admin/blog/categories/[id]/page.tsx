import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft } from "lucide-react";

import { requirePermission } from "@/lib/auth/session";
import { blogService } from "@/modules/blog/service";
import { isUuid } from "@/lib/utils/uuid";
import { BlogCategoryEditForm } from "./edit-form";

export const metadata: Metadata = { title: "Modifier la catégorie blog" };

export default async function BlogCategoryEditPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  await requirePermission("blog_cats", "view");
  if (!isUuid(id)) notFound();
  const cat = await blogService.findCategoryById(id);
  if (!cat) notFound();

  return (
    <div className="space-y-6">
      <div>
        <Link
          href="/admin/blog/categories"
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="h-3 w-3" /> Retour aux catégories
        </Link>
        <h1 className="mt-2 text-[26px] font-black tracking-[-0.02em] text-foreground sm:text-[30px]">
          {cat.name}
        </h1>
        <p className="mt-1 text-[14px] text-muted-foreground">/blog/{cat.slug}</p>
      </div>

      <BlogCategoryEditForm
        initial={{
          id: cat.id,
          slug: cat.slug,
          name: cat.name,
          description: cat.description,
          displayOrder: cat.display_order,
          isActive: cat.is_active,
          metaTitle: cat.meta_title,
          metaDescription: cat.meta_description,
          noindex: cat.noindex,
        }}
      />
    </div>
  );
}
