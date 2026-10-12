import { notFound, permanentRedirect } from "next/navigation";

import { getProductById } from "@/storefront/lib/api/products";

// Legacy Lovable product URLs were /p/<id>. Products now live at the flat
// /<slug> route, so resolve the id and 308 permanent-redirect to the slug
// (matches the other legacy redirects in the repo — a permanent move).
export default async function LegacyProductRedirect({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const product = await getProductById(id);
  if (!product) notFound();
  permanentRedirect(`/${product.slug}`);
}
