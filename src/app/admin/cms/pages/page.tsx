import type { Metadata } from "next";

import { requirePermission } from "@/lib/auth/session";
import { pageService } from "@/modules/cms/page/service";
import { PagesPanel } from "./pages-panel";

export const metadata: Metadata = { title: "Pages" };

export default async function CmsPagesAdmin() {
  await requirePermission("pages", "view");
  const list = await pageService.listAll();
  return (
    <PagesPanel
      pages={list.map((p) => ({
        id: p.id,
        slug: p.slug,
        title: p.title,
        isPublished: p.is_published,
        isSystem: p.is_system,
        publishedAt: p.published_at?.toISOString() ?? null,
      }))}
    />
  );
}
