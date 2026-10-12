import "server-only";

import { z } from "zod";

import { CART_LINE_QTY_MAX, cartService } from "@/modules/cart/service";
import { careService } from "@/modules/catalog/care/service";
import { productService } from "@/modules/catalog/product/service";
import { findVariantById } from "@/modules/catalog/product/queries";
import { resolvePromotionalUnitPriceCents } from "@/lib/cart/pricing";
import { getSharedStockDefault, isSharedStock } from "@/lib/inventory/variant-stock";
import { purchaseQtyViolation } from "@/lib/cart/purchase-limits";
import { fail, ok, workflow } from "../shared";

export const addToCartSchema = z.object({
  cartId: z.string().uuid(),
  productId: z.string().uuid(),
  /** Selected variant for a variable product. Omit/null for a simple one. */
  variantId: z.string().uuid().nullable().optional(),
  quantity: z.number().int().min(1).max(99).default(1),
});

export const addToCartWorkflow = workflow<
  [z.input<typeof addToCartSchema>],
  { cartItemId: string }
>("cart.add", async (input) => {
  const parsed = addToCartSchema.safeParse(input);
  if (!parsed.success) return fail("validation", "Validation échouée");

  const product = await productService.findById(parsed.data.productId);
  if (!product || !product.is_published) {
    return fail("not_found", "Produit introuvable.");
  }

  // Per-product purchase-quantity limits (the authoritative gate is place-order,
  // which aggregates the qty PER PRODUCT across sibling variant lines; this is a
  // friendly early reject on the requested qty only). A repeat add that would
  // push the merged line past `max` (or past 99) is CAPPED by upsertItem's ON
  // CONFLICT; a max spread across several variants of the same product is
  // caught at place-order, not here.
  const limitViolation = purchaseQtyViolation(parsed.data.quantity, {
    min: product.min_purchase_qty,
    max: product.max_purchase_qty,
  });
  if (limitViolation === "above_max") {
    return fail("max_purchase_qty", `Ce produit est limité à ${product.max_purchase_qty} par commande.`);
  }
  if (limitViolation === "below_min") {
    return fail("min_purchase_qty", `Quantité minimum : ${product.min_purchase_qty} par commande.`);
  }

  // A VARIABLE product is only sellable through one of its variants: place-order
  // refuses a variant-less line on it ("Choisissez une option…"), so refuse it
  // here too rather than letting the shopper build a cart checkout will reject
  // (a quick-add / stale link / old reorder line that carries no variant).
  if (!parsed.data.variantId && product.product_type === "variable") {
    return fail("needs_options", "Choisissez les options sur la fiche produit.");
  }

  // Cart-layer stock gate for SIMPLE products (the variant branch below already
  // gates on `variant.in_stock`). A product must be in stock to enter the cart,
  // so the shopper isn't allowed to invest in the flow only to be blocked at
  // checkout. `stock_qty === null` = untracked → sellable while `in_stock`.
  // The hard oversell guard still lives at order placement (race-safe `gte`).
  if (!parsed.data.variantId && !product.in_stock) {
    return fail("out_of_stock", "Ce produit n'est plus disponible.");
  }

  // A selected variant governs the price + stock. Empty string ('' not NULL)
  // is the "no variant" sentinel the unique index / merge relies on.
  let variantId = "";
  let unitPriceCents = product.price_cents;
  if (parsed.data.variantId) {
    const variant = await findVariantById(parsed.data.variantId);
    if (!variant || variant.product_id !== product.id) {
      return fail("not_found", "Variante introuvable.");
    }
    if (!variant.in_stock) {
      return fail("out_of_stock", "Cette variante n'est plus disponible.");
    }
    const sharedDefault = await getSharedStockDefault();
    const shared = isSharedStock(product.shared_variant_stock, sharedDefault);
    // SHARED mode: the variant draws from the parent pool, so a sold-out pool
    // (product.in_stock=false) blocks the add too.
    if (shared && !product.in_stock) {
      return fail("out_of_stock", "Ce produit n'est plus disponible.");
    }
    // SHARED mode single-line qty gate against the PARENT pool — mirror the
    // per-variant gate below so an over-add (qty > pool) is caught at add time,
    // not only by the race-safe checkout gate. Cross-line accumulation stays
    // checkout-final by design.
    if (
      shared &&
      product.stock_qty !== null &&
      product.stock_qty < parsed.data.quantity
    ) {
      return fail("out_of_stock", "Stock insuffisant pour ce produit.");
    }
    // PER-VARIANT mode: a TRACKED variant (stock_qty !== null) with too little
    // stock is unsellable — matches variantInStock() + the order-time race-safe
    // `gte` guard. Reject at add time (untracked NULL stays sellable) so the
    // shopper isn't blocked only at checkout, mirroring the PDP which greys the
    // value out.
    if (
      !shared &&
      variant.stock_qty !== null &&
      variant.stock_qty < parsed.data.quantity
    ) {
      return fail("out_of_stock", "Stock insuffisant pour cette variante.");
    }
    variantId = variant.id;
    unitPriceCents = variant.price_cents;
  }

  // Bake the active auto-promotion (product/category/brand scope) into the
  // stored unit price, so the cart, checkout, and order all charge the promo
  // price the PDP advertised — `unit_price_cents` is the single source of
  // truth every downstream layer reads. Cart-scope coupons are applied
  // separately at the cart-total layer, so there is no double-apply.
  unitPriceCents = await resolvePromotionalUnitPriceCents(product.id, unitPriceCents, variantId || null);

  const row = await cartService.upsertItem({
    cart_id: parsed.data.cartId,
    product_id: product.id,
    variant_id: variantId,
    quantity: parsed.data.quantity,
    unit_price_cents: unitPriceCents,
  });

  return ok({ cartItemId: row.id });
});

export const setCartItemQuantityWorkflow = workflow<
  [{ itemId: string; quantity: number; cartId: string }],
  { itemId: string }
>("cart.set_quantity", async ({ itemId, quantity, cartId }) => {
  if (!Number.isFinite(quantity)) return fail("validation", "Quantité invalide.");
  // Ownership check — without this, any visitor with a known itemId
  // could mutate any cart in the system (IDOR).
  const item = await cartService.findItemById(itemId);
  if (!item || item.cart_id !== cartId) {
    return fail("not_found", "Article introuvable.");
  }
  // Per-product purchase-qty limits (friendly reject; place-order is the
  // authoritative gate). 0 always removes the line, so it bypasses the min
  // check — a below-min line can only be emptied, never left at an invalid qty.
  const requested = Math.min(CART_LINE_QTY_MAX, Math.max(0, Math.floor(quantity)));
  if (requested > 0) {
    const product = await productService.findById(item.product_id);
    if (product) {
      const limitViolation = purchaseQtyViolation(requested, {
        min: product.min_purchase_qty,
        max: product.max_purchase_qty,
      });
      if (limitViolation === "above_max") {
        return fail("max_purchase_qty", `Ce produit est limité à ${product.max_purchase_qty} par commande.`);
      }
      if (limitViolation === "below_min") {
        return fail("min_purchase_qty", `Quantité minimum : ${product.min_purchase_qty} par commande.`);
      }
    }
  }
  // Clamp to the same ceiling as add-to-cart (99). Without this upper bound a
  // tampered request could set an arbitrary quantity; for a TRACKED product the
  // place-order stock `gte` guard would still reject oversell, but an UNTRACKED
  // product (stock_qty NULL) skips that gate, so an absurd quantity would pass
  // through and be charged. 0 still removes the line (setQuantity deletes at ≤0).
  await cartService.setQuantity(itemId, requested);
  return ok({ itemId });
});

export const setCartItemCarePlanWorkflow = workflow<
  [{ itemId: string; cartId: string; carePlanId: string | null }],
  { itemId: string }
>("cart.set_care_plan", async ({ itemId, cartId, carePlanId }) => {
  // Ownership check (IDOR): the line must belong to THIS cart.
  const item = await cartService.findItemById(itemId);
  if (!item || item.cart_id !== cartId) {
    return fail("not_found", "Article introuvable.");
  }
  // A non-null plan must exist + be active (a deleted/disabled plan is rejected so
  // the cart never stores a dangling choice). Full offering + pricing is
  // re-validated authoritatively at place-order; the storefront only offers plans
  // that genuinely apply, so an honest flow always passes.
  if (carePlanId) {
    const plan = await careService.findById(carePlanId);
    if (!plan || !plan.is_active) return fail("not_found", "Plan Tokyo Care introuvable.");
  }
  await cartService.setCarePlan(itemId, carePlanId ?? null);
  return ok({ itemId });
});

export const removeCartItemWorkflow = workflow<
  [{ itemId: string; cartId: string }],
  { itemId: string }
>("cart.remove", async ({ itemId, cartId }) => {
  const item = await cartService.findItemById(itemId);
  if (!item || item.cart_id !== cartId) {
    return fail("not_found", "Article introuvable.");
  }
  await cartService.deleteItem(itemId);
  return ok({ itemId });
});
