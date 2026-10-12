import type { Metadata } from "next";

import { requirePermission } from "@/lib/auth/session";
import { blogService } from "@/modules/blog/service";
import { TagsPanel } from "./tags-panel";

export const metadata: Metadata = { title: "Tags blog" };

export default async function AdminBlogTagsPage() {
  await requirePermission("blog_tags", "view");
  const tags = await blogService.listTags();
  return (
    <TagsPanel
      tags={tags.map((t) => ({ id: t.id, name: t.name, slug: t.slug }))}
    />
  );
}
