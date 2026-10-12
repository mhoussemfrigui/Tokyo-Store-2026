/**
 * Promotion module — public surface.
 *
 * Storefront / admin consumers import from here:
 *
 *   import {
 *     promotionService,
 *     getActiveDiscountForProduct,
 *     resolveProductDiscount,
 *     computeProductDiscount,
 *     type ProductDiscount,
 *   } from "@/modules/promotion";
 */

export {
  promotionService,
  getActiveDiscountForProduct,
  resolveLivePromotionRowsForProducts,
  rowsForLineVariant,
  type LivePromoEntry,
  productsMatchingScope,
  productsMatchingPromoScope,
  effectiveScopeTargets,
  listNonDiscountableProductIds,
  resolveProductDiscount,
  computeProductDiscount,
  type ProductDiscount,
} from "./queries";

export type {
  PromotionRow,
  NewPromotionRow,
  PromotionRedemptionRow,
  NewPromotionRedemptionRow,
  PromotionScope,
  PromotionScopeTargetRow,
  PromotionScopeTargetType,
} from "./schema";
