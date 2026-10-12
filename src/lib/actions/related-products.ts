"use server";

import { requirePermissionAny } from "@/lib/auth/session";
import { productPickerOptionsForIds } from "@/lib/catalog/product-picker-options.server";
import { resolveUrlMap } from "@/modules/media/queries";
import { searchProducts } from "@/modules/search/queries";

/**
 * Admin server actions backing the shared product picker — the product editor's
 * "Vous aimerez aussi" picker (manual mode), the collection editor's product list,
 * the manual-review modal and the showcase (Catalogues) pin picker.
 *   • searchProductsForPickerAction — FTS search for the manual picker.
 *   • resolveRelatedProductOptionsAction — hydrate stored ids → cards (edit init).
 * (The former AI-pick mode was removed with the rest of AI generation.)
 */

/**
 * Who may search / hydrate picker cards (read-only id/slug/name/image/price —
 * the same public catalogue data the storefront lists). Not just `products:view`:
 * a review moderator creating a manual review (reviews:create) and a showcase
 * editor pinning products (showcase:update) use the same picker, and with a
 * products-only gate their searches silently came back empty (plus a false
 * permission-denied probe per keystroke). Mirrors manual-order.ts's per-domain
 * picker grants.
 */
const PICKER_GRANTS = [
  { module: "products", action: "view" },
  { module: "reviews", action: "create" },
  { module: "showcase", action: "update" },
] as const;

export type RelatedProductOption = {
  id: string;
  slug: string;
  name: string;
  imageUrl: string | null;
  priceCents: number;
};

const SEARCH_LIMIT = 20;

export async function searchProductsForPickerAction(
  query: string,
): Promise<RelatedProductOption[]> {
  await requirePermissionAny(PICKER_GRANTS);
  const q = query.trim();
  if (q.length < 2) return [];
  const hits = await searchProducts(q, SEARCH_LIMIT);
  const urls = await resolveUrlMap(
    hits.map((h) => h.image_media_id).filter((x): x is string => Boolean(x)),
  );
  return hits.map((h) => ({
    id: h.id,
    slug: h.slug,
    name: h.title,
    imageUrl: h.image_media_id ? (urls.get(h.image_media_id) ?? null) : null,
    priceCents: h.price_cents,
  }));
}

export async function resolveRelatedProductOptionsAction(
  ids: string[],
): Promise<RelatedProductOption[]> {
  await requirePermissionAny(PICKER_GRANTS);
  return productPickerOptionsForIds(ids);
}
