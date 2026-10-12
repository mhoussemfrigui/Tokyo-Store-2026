import "server-only";

import { productQueries } from "@/modules/catalog/product";
import type { ProductRow, ProductVariantRow } from "@/modules/catalog/product/schema";
import { productMediaLink, productCategoryLinks } from "@/associations/catalog.service";
import { mediaQueries } from "@/modules/media";
import { resolveMediaThumbUrl } from "@/modules/media/url-resolver";
import { categoryWarrantyFromChain, getDefaultWarranty, resolveWarranty } from "@/lib/warranty";
import { loadCategoryChains } from "@/lib/catalog/category-chain";
import { categoryChainTaxBps, computeTaxCents, resolveTaxRateBps } from "@/lib/tax";
import { taxQueries } from "@/modules/tax";
import {
  resolveLivePromotionRowsForProducts,
  rowsForLineVariant,
  resolveProductDiscount,
} from "@/modules/promotion";
import { getSharedStockDefault, isSharedStock } from "@/lib/inventory/variant-stock";
import type { NewOrderItemRow } from "@/modules/order/schema";

export type AddLineInput = { productId: string; variantId?: string | null; quantity: number };

export type BuiltAddLine = {
  product: ProductRow;
  variant: ProductVariantRow | null;
  /** Stock target is the variant unless the product is shared-mode. */
  decrementsVariant: boolean;
  /** order_items insert payload minus order_id. */
  values: Omit<NewOrderItemRow, "order_id">;
};

/** Named, customer-safe failure for an unavailable / mis-configured added line. */
export class BuildLineError extends Error {
  constructor(public readonly userMessage: string) {
    super(userMessage);
    this.name = "BuildLineError";
  }
}

/**
 * Build full order_items snapshots for a set of operator-ADDED lines, reusing
 * the EXACT place-order resolution (live product/variant rows, primary + variant
 * image, warranty cascade product→category→global, the tax cascade product→
 * filter→brand→category→global, and live auto-promotion pricing) — so a line an
 * operator adds post-sale is priced + snapshotted identically to a storefront
 * checkout line. Throws BuildLineError for an unavailable / out-of-stock /
 * variant-required line (the caller maps it to a fail()). Batched: O(1) queries
 * regardless of the number of added lines.
 */
export async function buildAddLineSnapshots(
  inputs: AddLineInput[],
  taxConfig: { mode: "ht" | "ttc" | "disabled"; defaultRateBps: number },
): Promise<BuiltAddLine[]> {
  if (inputs.length === 0) return [];
  const productIds = [...new Set(inputs.map((i) => i.productId))];

  const [productRows, primaryMediaIdsByProduct, variantsByProduct] = await Promise.all([
    productQueries.listProductsByIds(productIds),
    productMediaLink.primaryMediaIdsForProducts(productIds),
    productQueries.listVariantsForProducts(productIds),
  ]);
  const productById = new Map(productRows.map((p) => [p.id, p]));
  const variantById = new Map([...variantsByProduct.values()].flat().map((v) => [v.id, v]));
  const mediaIds = [
    ...new Set([
      ...primaryMediaIdsByProduct.values(),
      ...[...variantsByProduct.values()]
        .flat()
        .map((v) => v.image_media_id)
        .filter((id): id is string => Boolean(id)),
    ]),
  ];
  const mediaMap = await mediaQueries.findMediaByIds(mediaIds);

  const [globalWarranty, primaryCatByProduct, taxRuleBpsByProduct, taxBrandBpsByProduct, promoRowsByProduct] =
    await Promise.all([
      getDefaultWarranty(),
      productCategoryLinks.primaryCategoriesForProducts(productIds),
      taxQueries.taxRuleBpsForProducts(productIds),
      taxQueries.brandTaxBpsForProducts(productIds),
      resolveLivePromotionRowsForProducts(productIds).catch(
        () => new Map<string, { discountable: boolean; rows: never[] }>(),
      ),
    ]);
  // FULL primary-category ancestor chain (child → root), same resolver as
  // place-order — a rate / warranty set on any ancestor (not just the direct
  // parent) governs the line.
  const catChains = await loadCategoryChains(primaryCatByProduct.values());

  const warrantyByProduct = new Map<string, { months: number | null; label: string | null }>();
  const taxCategoryBpsByProduct = new Map<string, number | null>();
  for (const p of productRows) {
    const catId = primaryCatByProduct.get(p.id);
    const chain = catId ? (catChains.get(catId) ?? []) : [];
    const resolved = resolveWarranty(
      { months: p.warranty_months ?? null, label: p.warranty_label ?? null },
      categoryWarrantyFromChain(chain),
      globalWarranty,
    );
    warrantyByProduct.set(p.id, {
      months: resolved.months > 0 ? resolved.months : null,
      label: resolved.display,
    });
    taxCategoryBpsByProduct.set(p.id, categoryChainTaxBps(chain.map((c) => c.tax_rate_bps)));
  }

  const sharedDefault = await getSharedStockDefault();

  return inputs.map((inp) => {
    const product = productById.get(inp.productId);
    if (!product || !product.is_published) {
      throw new BuildLineError(`Le produit ${product?.name ?? ""} n'est plus disponible.`.trim());
    }
    if (product.product_type === "variable" && !inp.variantId) {
      throw new BuildLineError(`Choisissez une variante pour « ${product.name} ».`);
    }
    if (inp.variantId && product.product_type !== "variable") {
      throw new BuildLineError(`${product.name} n'est plus proposé en variantes.`);
    }
    const variant = inp.variantId ? (variantById.get(inp.variantId) ?? null) : null;
    if (inp.variantId && (!variant || variant.product_id !== product.id)) {
      throw new BuildLineError(`Variante indisponible pour « ${product.name} ».`);
    }

    const shared = Boolean(variant) && isSharedStock(product.shared_variant_stock, sharedDefault);
    const label = variant ? ` (${variant.label})` : "";
    if (!(variant ?? product).in_stock || (shared && !product.in_stock)) {
      throw new BuildLineError(`${product.name}${label} n'est plus disponible.`);
    }
    const qtyTarget = shared ? product : (variant ?? product);
    if (qtyTarget.stock_qty !== null && inp.quantity > qtyTarget.stock_qty) {
      throw new BuildLineError(`${product.name}${label} : stock insuffisant.`);
    }

    // Live auto-promotion pricing (mirrors place-order) — the line is priced
    // exactly as the storefront would price it right now.
    const base = variant ? variant.price_cents : product.price_cents;
    const entry = promoRowsByProduct.get(product.id);
    // Per-variant (migration 0173): the line's variant decides which promos apply.
    const lineRows = entry && entry.discountable ? rowsForLineVariant(entry, variant?.id ?? null) : [];
    const unitPrice =
      lineRows.length === 0
        ? base
        : (resolveProductDiscount(base, lineRows)?.effectivePriceCents ?? base);

    const primaryMediaId = primaryMediaIdsByProduct.get(product.id);
    const imageUrl = primaryMediaId ? resolveMediaThumbUrl(mediaMap.get(primaryMediaId)) : null;
    const variantImageUrl = variant?.image_media_id
      ? resolveMediaThumbUrl(mediaMap.get(variant.image_media_id))
      : null;

    const lineSubtotal = unitPrice * inp.quantity;
    const { bps } = resolveTaxRateBps({
      productTaxBps: product.tax_rate_bps ?? null,
      matchedRuleBps: taxRuleBpsByProduct.get(product.id) ?? null,
      brandTaxBps: taxBrandBpsByProduct.get(product.id) ?? null,
      categoryChainTaxBps: taxCategoryBpsByProduct.get(product.id) ?? null,
      globalBps: taxConfig.defaultRateBps,
    });
    const taxCents = computeTaxCents(lineSubtotal, bps, taxConfig.mode);

    return {
      product,
      variant,
      decrementsVariant: Boolean(variant) && !shared,
      values: {
        product_id: product.id,
        product_name: product.name,
        product_slug: product.slug,
        product_sku: variant?.sku ?? product.sku,
        product_image_url: imageUrl,
        variant_id: variant?.id ?? null,
        variant_sku: variant?.sku ?? null,
        variant_label: variant?.label || null,
        variant_image_url: variantImageUrl,
        warranty_months: warrantyByProduct.get(product.id)?.months ?? null,
        warranty_label: warrantyByProduct.get(product.id)?.label ?? null,
        unit_price_cents: unitPrice,
        quantity: inp.quantity,
        subtotal_cents: lineSubtotal,
        tax_cents: taxCents,
        tax_rate_bps: taxConfig.mode === "disabled" ? null : bps,
      },
    };
  });
}
