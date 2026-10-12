import "server-only";

import { getActiveDiscountForProduct } from "@/modules/promotion";
import { productBrandLink, productCategoryLinks } from "@/associations/catalog.service";

/**
 * Resolve the effective unit price for a product after any active *automatic*
 * promotion (product / category / brand scope).
 *
 * This is the single place the write path bakes a promo into the stored
 * `cart_items.unit_price_cents`, so the cart, checkout, and order all charge
 * the price the PDP advertised. It loads the product's DIRECT category links +
 * brand id and hands them to `getActiveDiscountForProduct`, which expands the
 * categories to their ANCESTORS for matching (so a parent-category promo cascades
 * to this product) — callers pass only the product id + its base unit price.
 *
 * Cart-scope coupons are deliberately NOT handled here — they discount the
 * order total at the cart layer (`@/lib/cart/coupon`), so applying them here
 * too would double-count. Returns the input price unchanged when no auto
 * promotion applies, and never throws (a promo-lookup failure degrades to the
 * undiscounted price rather than blocking add-to-cart / checkout).
 *
 * KEEP IN SYNC with `src/workflows/order/place-order.ts`, which re-implements
 * this exact resolution in a BATCHED form (`resolveLivePromotionRowsForProducts`
 * + `resolveProductDiscount`, O(1) queries for a whole cart) to re-price every
 * line at checkout. The two paths MUST stay behaviourally identical — same
 * stacked-promo compounding + non-discountable guard — or a line could be added
 * to the cart at one price and charged another. Change the rule here → mirror it
 * there (and vice-versa).
 */
export async function resolvePromotionalUnitPriceCents(
  productId: string,
  unitPriceCents: number,
  variantId?: string | null,
): Promise<number> {
  try {
    const [categoryLinks, brandId] = await Promise.all([
      productCategoryLinks.listForProduct(productId).catch(() => []),
      productBrandLink.findBrandId(productId).catch(() => null),
    ]);
    const discount = await getActiveDiscountForProduct({
      productId,
      unitPriceCents,
      categoryIds: categoryLinks.map((l) => l.category_id),
      brandIds: brandId ? [brandId] : [],
      // Per-variant (migration 0173): a variant-constrained promo bakes into the cart
      // price ONLY for its variant — MUST match place-order's re-price (keep-in-sync).
      variantId: variantId ?? null,
    });
    return discount ? discount.effectivePriceCents : unitPriceCents;
  } catch {
    return unitPriceCents;
  }
}
