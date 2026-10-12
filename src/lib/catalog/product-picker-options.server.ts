import "server-only";

import { productMediaLink } from "@/associations/catalog.service";
import type { RelatedProductOption } from "@/lib/actions/related-products";
import { productService } from "@/modules/catalog/product/service";
import { resolveUrlMap } from "@/modules/media/queries";

/**
 * Resolve product ids → product-picker cards (id / slug / name / primary image /
 * price), preserving the input order and dropping ids whose product was deleted
 * since they were stored.
 *
 * Plain server-only module on purpose (NOT a "use server" file): every export of
 * a "use server" file is a publicly callable Server Action, and this helper
 * carries no permission gate of its own. The CALLER's guard applies — the
 * collection editor page hydrates its assigned products under `collections:view`
 * without needing `products:view` (the gated `resolveRelatedProductOptionsAction`
 * would 404 the whole page for a collections-only role).
 */
export async function productPickerOptionsForIds(ids: string[]): Promise<RelatedProductOption[]> {
  const valid = ids.filter((x) => typeof x === "string" && x.length > 0);
  if (valid.length === 0) return [];
  const rows = await productService.listByIds(valid);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const mediaMap = await productMediaLink.primaryMediaIdsForProducts(valid);
  const urls = await resolveUrlMap([...mediaMap.values()]);
  const out: RelatedProductOption[] = [];
  for (const id of valid) {
    const r = byId.get(id);
    if (!r) continue; // dropped (deleted since stored)
    const mediaId = mediaMap.get(id);
    out.push({
      id: r.id,
      slug: r.slug,
      name: r.name,
      imageUrl: mediaId ? (urls.get(mediaId) ?? null) : null,
      priceCents: r.price_cents,
    });
  }
  return out;
}
