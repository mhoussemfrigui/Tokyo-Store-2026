import "server-only";

import { productQueries } from "@/modules/catalog/product";
import { resolveLivePromotionRowsForProducts, rowsForLineVariant } from "@/modules/promotion";
import { resolveProductDiscount } from "@/lib/promotions/product-discount";
import { discountableSubtotalCents } from "@/lib/promotions/discountable-subtotal";
import type { CouponCartLine } from "@/lib/promotions/scoped-coupon";

/**
 * LIVE re-price of a persisted cart — the batched form the /panier and /checkout
 * pages use, and that place-order applies authoritatively: each line's unit price
 * is the CURRENT base (variant or product) with the live auto-promotions applied,
 * never the `cart_items.unit_price_cents` frozen at add-to-cart (stale once a
 * promo expires / starts or a base price changes). O(1) queries for the whole
 * cart; a promo-lookup failure degrades to the base price, and a line whose
 * product / variant is gone keeps its cached price (place-order refuses it).
 *
 * Used by the coupon gates of the cart server actions (`placeOrderFromCartAction`
 * picks the coupon candidate, `applyCouponAction` checks min-cart / scope) so they
 * decide on the SAME subtotal + lines the pages display — the add-time
 * `getCartSummary` total could pick a different coupon than /checkout showed.
 *
 * KEEP IN SYNC with the page copies (src/app/(shop)/panier/page.tsx,
 * src/app/(shop)/checkout/page.tsx) and `src/workflows/order/place-order.ts`.
 */
export type LiveCartLine = {
  productId: string;
  quantity: number;
  /** Live effective unit price (base + live auto-promos). */
  unitCents: number;
  /** Catalogue base unit price (pre-promo). */
  baseCents: number;
  /** unitCents × quantity. */
  lineCents: number;
  /** baseCents × quantity. */
  baseLineCents: number;
};

export type LiveCartPricing = {
  lines: LiveCartLine[];
  subtotalCents: number;
  /** Subtotal of the NON-discounted lines (exclude-discounted-items coupon base). */
  discountableSubtotalCents: number;
};

export async function priceCartLinesLive(
  items: ReadonlyArray<{
    product_id: string;
    variant_id: string | null;
    quantity: number;
    unit_price_cents: number;
  }>,
): Promise<LiveCartPricing> {
  if (items.length === 0) return { lines: [], subtotalCents: 0, discountableSubtotalCents: 0 };
  const productIds = Array.from(new Set(items.map((it) => it.product_id)));
  const [productRows, variantsByProduct, promoRowsByProduct] = await Promise.all([
    productQueries.listProductsByIds(productIds),
    productQueries.listVariantsForProducts(productIds),
    resolveLivePromotionRowsForProducts(productIds).catch(
      () => new Map<string, { discountable: boolean; rows: never[] }>(),
    ),
  ]);
  const productMap = new Map(productRows.map((p) => [p.id, p]));
  const variantById = new Map([...variantsByProduct.values()].flat().map((v) => [v.id, v]));

  const lines = items.map((it): LiveCartLine => {
    const p = productMap.get(it.product_id);
    // variant_id is '' for a simple product.
    const variant = it.variant_id ? variantById.get(it.variant_id) : undefined;
    const variantMissing = Boolean(it.variant_id) && !variant;
    const liveBase = variant ? variant.price_cents : p?.price_cents;
    const promoEntry = promoRowsByProduct.get(it.product_id);
    // Per-variant (migration 0173): a variant-constrained promo applies only to its
    // variant (variant_id is '' for a simple product → null = all variants).
    const lineRows =
      promoEntry && promoEntry.discountable
        ? rowsForLineVariant(promoEntry, it.variant_id || null)
        : [];
    const unitCents =
      variantMissing || !p || liveBase == null
        ? it.unit_price_cents
        : lineRows.length > 0
          ? resolveProductDiscount(liveBase, lineRows)?.effectivePriceCents ?? liveBase
          : liveBase;
    const baseCents = variantMissing ? unitCents : (liveBase ?? unitCents);
    return {
      productId: it.product_id,
      quantity: it.quantity,
      unitCents,
      baseCents,
      lineCents: unitCents * it.quantity,
      baseLineCents: baseCents * it.quantity,
    };
  });

  return {
    lines,
    subtotalCents: lines.reduce((acc, l) => acc + l.lineCents, 0),
    discountableSubtotalCents: discountableSubtotalCents(lines),
  };
}

/** The per-line coupon context (`CouponCartLine`) of a live-priced cart. */
export function couponLinesOf(pricing: LiveCartPricing): CouponCartLine[] {
  return pricing.lines.map((l) => ({
    productId: l.productId,
    lineCents: l.lineCents,
    baseLineCents: l.baseLineCents,
  }));
}
