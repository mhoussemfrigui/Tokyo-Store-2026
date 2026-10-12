import "server-only";

import { productCategoryLinks, productBrandLink } from "@/associations/catalog.service";
import {
  getActiveDiscountForProduct,
  resolveLivePromotionRowsForProducts,
  rowsForLineVariant,
  resolveProductDiscount,
  type LivePromoEntry,
} from "@/modules/promotion";
import { minorToDinars } from "@/lib/price";
import type { Product } from "@/types/catalog";

/**
 * The PDP's live AUTO-promotion price resolution for ONE product, as a shared
 * helper — so a single-product surface outside the PDP (the `/md` Markdown twin)
 * prints the SAME effective price the PDP shows and the cart charges, instead of
 * the bare base price. Mirrors `renderProductView` ((shop)/[slug]/page.tsx)
 * step for step:
 *   • SIMPLE product → `getActiveDiscountForProduct` on the row's base
 *     `price_cents`; the original becomes the struck-through reference (or the
 *     higher merchandiser compare-at).
 *   • VARIABLE product → the same engine PER VARIANT (each variant's own base
 *     price, the live auto-promo rows fetched once), then the parent "à partir
 *     de" is recomputed from the discounted variant minimum.
 * Coupon / URL promotions are cart-layer only and never applied here.
 *
 * MUTATES `product` IN PLACE (price/oldPrice + their *_cents, and each variant's
 * priceCents/oldPriceCents). Pass a COPY of any cross-request cached DTO — see
 * {@link withLivePromoPricing}. `links` lets a caller that already loaded the
 * product's category/brand links (the PDP) skip the two lookups.
 */
export async function applyLivePromoPricing(
  product: Product,
  row: { id: string; price_cents: number },
  links?: { categoryIds: string[]; brandIds: string[] },
): Promise<void> {
  let categoryIds: string[];
  let brandIds: string[];
  if (links) {
    ({ categoryIds, brandIds } = links);
  } else {
    const [cats, brandId] = await Promise.all([
      productCategoryLinks.listForProduct(row.id).catch(() => []),
      productBrandLink.findBrandId(row.id).catch(() => null),
    ]);
    categoryIds = cats.map((l) => l.category_id);
    brandIds = brandId ? [brandId] : [];
  }

  const hasVariants = (product.variants?.length ?? 0) > 0;

  if (hasVariants && product.variants) {
    // VARIABLE product: the promo applies to each variant's OWN base price (what
    // add-to-cart bakes), not to the parent's — see the PDP comment. Resolve per
    // VARIANT (migration 0173) and DON'T gate on a product-level discount: a
    // variant-only promo returns null at product level. `discountable:false` on the
    // entry still honours the non-discountable guard.
    const promoEntry = (
      await resolveLivePromotionRowsForProducts([row.id]).catch(
        () => new Map<string, LivePromoEntry>(),
      )
    ).get(row.id);
    if (
      promoEntry &&
      promoEntry.discountable &&
      (promoEntry.rows.length > 0 || (promoEntry.rowsByVariant?.size ?? 0) > 0)
    ) {
      let anyDiscounted = false;
      let minEffective = Infinity;
      for (const v of product.variants) {
        const d = resolveProductDiscount(v.priceCents, rowsForLineVariant(promoEntry, v.id));
        const effective = d ? d.effectivePriceCents : v.priceCents;
        if (effective < v.priceCents) {
          v.oldPriceCents = Math.max(v.priceCents, v.oldPriceCents ?? 0);
          v.priceCents = effective;
          anyDiscounted = true;
        }
        if (effective < minEffective) minEffective = effective;
      }
      if (anyDiscounted) {
        product.oldPriceCents = Math.max(product.priceCents, product.oldPriceCents ?? 0);
        product.priceCents = minEffective;
        product.oldPrice = minorToDinars(product.oldPriceCents);
        product.price = minorToDinars(product.priceCents);
      }
    }
    return;
  }

  // SIMPLE product (no variants): a variant-constrained promo can't apply, so the
  // product-level discount is authoritative.
  const activeDiscount = await getActiveDiscountForProduct({
    productId: row.id,
    unitPriceCents: row.price_cents,
    categoryIds,
    brandIds,
  }).catch(() => null);
  if (!activeDiscount) return;

  // Effective price up front, original as the struck-through reference (higher of the
  // base price and any merchandiser compare-at).
  product.oldPriceCents = Math.max(row.price_cents, product.oldPriceCents ?? 0);
  product.priceCents = activeDiscount.effectivePriceCents;
  product.oldPrice = minorToDinars(product.oldPriceCents);
  product.price = minorToDinars(product.priceCents);
}

/**
 * Non-mutating wrapper: returns a promo-priced COPY of `product` (only the
 * fields {@link applyLivePromoPricing} writes are copied — the product itself
 * and each variant), leaving a cached DTO untouched.
 */
export async function withLivePromoPricing(
  product: Product,
  row: { id: string; price_cents: number },
): Promise<Product> {
  const copy: Product = {
    ...product,
    variants: product.variants?.map((v) => ({ ...v })),
  };
  await applyLivePromoPricing(copy, row);
  return copy;
}
