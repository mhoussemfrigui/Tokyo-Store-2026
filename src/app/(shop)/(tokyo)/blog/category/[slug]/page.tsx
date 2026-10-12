import { permanentRedirect } from "next/navigation";

import { blogCategoryPath } from "@/lib/blog/paths";

/**
 * Legacy `/blog/category/<slug>` → flat `/blog/<slug>` (308). No `resolveRedirect`
 * (keeps it an APP_ROUTE_SHAPES "app" route for the reserved-routes drift test).
 * The flat `/blog/[slug]` route then resolves post-first-then-category.
 */
export const dynamic = "force-dynamic";

export default async function LegacyBlogCategoryRedirect({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  permanentRedirect(blogCategoryPath(slug));
}
