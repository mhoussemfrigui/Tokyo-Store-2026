import type { Metadata } from "next";

import { requirePermission } from "@/lib/auth/session";
import { blogService } from "@/modules/blog/service";
import { BlogCategoriesPanel } from "./categories-panel";

export const metadata: Metadata = { title: "Catégories blog" };

export default async function BlogCategoriesAdmin() {
  await requirePermission("blog_cats", "view");
  const cats = await blogService.listCategoriesForAdmin();
  return (
    <BlogCategoriesPanel
      categories={cats.map((c) => ({
        id: c.id,
        slug: c.slug,
        name: c.name,
        description: c.description,
        isActive: c.is_active,
      }))}
    />
  );
}
