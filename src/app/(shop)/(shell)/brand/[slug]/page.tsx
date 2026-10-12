import { permanentRedirect } from "next/navigation";

import { resolveRedirect } from "@/lib/redirects/resolve";

/**
 * Legacy brand route. Brands now resolve at the flat `/<slug>` namespace (same
 * as categories/products) via the unified `[slug]` resolver, so this path just
 * permanently redirects to the canonical root URL. Kept so old links, the
 * sitemap history, and any external references keep working.
 */
export default async function BrandRedirect({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  // Honor an admin redirect for the legacy /brand/<slug> URL before falling back
  // to the canonical flat namespace.
  await resolveRedirect(`/brand/${slug}`);
  permanentRedirect(`/${slug}`);
}
