"use server";

import { refresh } from "next/cache";
import { cookies } from "next/headers";

import { workflows } from "@/workflows";
import { resolveCart, readCart, CART_COOKIE } from "@/lib/cart/session";
import { getSession } from "@/lib/auth/session";
import { cartService } from "@/modules/cart/service";
import { cartEventService } from "@/modules/cart-event";
import { productService } from "@/modules/catalog/product/service";
import { type ActionState } from "@/lib/actions/types";

/**
 * Re-render the CURRENT page after a cart mutation so the server-rendered header
 * cart count (the dynamic (shop) layout) and /panier update. NOT
 * `revalidatePath("/", "layout")`: that writes the implicit `_N_T_/layout` tag
 * every page request carries, so each anonymous cart click expired EVERY
 * 'use cache' reader (PDP, category tree, brands, collections, blog) and the
 * feeds ISR site-wide. `refresh()` only re-renders dynamic data in the action
 * response (ActionDidRevalidateDynamicOnly) and leaves the caches alone — the
 * cart itself is never cached.
 */
function refreshCartViews(): void {
  refresh();
}

/**
 * Merge a leftover guest cart into the signed-in user's cart, then drop the
 * guest cookie. Runs on shop-page mount (CartMergeOnLogin) so a user who logs
 * in and goes straight to /checkout (which reads the cart in an RSC, never
 * resolving it) still gets their guest items — `resolveCart` covers the
 * mutation paths, this covers the passive read paths. Idempotent + row-locked
 * in the service, so the two triggers can't double-count. Returns whether any
 * items moved, so the client can refresh the server-rendered cart count.
 */
export async function mergeGuestCartAction(): Promise<{ merged: boolean }> {
  const session = await getSession();
  if (!session?.user) return { merged: false };
  const jar = await cookies();
  const guestToken = jar.get(CART_COOKIE)?.value;
  if (!guestToken) return { merged: false };
  const merged = await cartService
    .mergeGuestCart(guestToken, session.user.id)
    .catch(() => false);
  jar.delete(CART_COOKIE);
  return { merged };
}

/**
 * Read the caller's cart as a flat {slug, qty, itemId, carePlanId} list — hydrates
 * the new storefront's client cart store from the backend (read-only; never creates
 * a cart/cookie). Slug-level (the storefront cart is slug-keyed, simple products).
 * `carePlanId` is the line's chosen Tokyo Care plan (null when none), so the client
 * reads the protection selection from the backend (single source of truth) instead
 * of a local overlay.
 */
type StorefrontCartLine = { slug: string; qty: number; itemId: string; carePlanId: string | null };
export async function getStorefrontCartAction(): Promise<{ lines: StorefrontCartLine[] }> {
  const cart = await readCart();
  if (!cart) return { lines: [] };
  const items = await cartService.listItems(cart.id);
  if (items.length === 0) return { lines: [] };
  const ids = [...new Set(items.map((i) => i.product_id))];
  const products = await productService.listByIds(ids);
  const slugById = new Map(products.map((p) => [p.id, p.slug]));
  const lines = items
    .map((i) => {
      const slug = slugById.get(i.product_id);
      return slug ? { slug, qty: i.quantity, itemId: i.id, carePlanId: i.care_plan_id ?? null } : null;
    })
    .filter((l): l is StorefrontCartLine => l !== null);
  return { lines };
}

export async function addToCartAction(
  productId: string,
  quantity = 1,
  variantId?: string | null,
): Promise<ActionState> {
  const cart = await resolveCart();
  const result = await workflows.cart.add({
    cartId: cart.id,
    productId,
    variantId: variantId ?? null,
    quantity,
  });
  if (!result.ok) return { ok: false, error: result.error, message: result.message };
  // Add-to-cart analytics (best-effort): who added it — client (authenticated)
  // vs visitor (guest token). Never blocks the add.
  await cartEventService
    .record({
      productId,
      variantId,
      quantity,
      actorKind: cart.user_id ? "client" : "visitor",
      source: "cart",
    })
    .catch(() => {});
  refreshCartViews();
  return { ok: true, message: "Ajouté au panier." };
}

/**
 * Quick-add from a listing card, which only carries the product slug (not the
 * DB id). Resolves the product and refuses: unpublished rows, variable products
 * (they need an option choice on the PDP), and out-of-stock items (handled on
 * the PDP). This is the SERVER-SIDE enforcement of the card's UI guard — it
 * never trusts the client-only button rendering.
 */
export async function addToCartBySlugAction(slug: string, quantity = 1): Promise<ActionState> {
  const product = await productService.findBySlug(slug);
  if (!product || !product.is_published) {
    return { ok: false, error: "not_found", message: "Produit introuvable." };
  }
  if (product.product_type === "variable") {
    return {
      ok: false,
      error: "needs_options",
      message: "Choisissez les options sur la fiche produit.",
    };
  }
  if (!product.in_stock) {
    return { ok: false, error: "unavailable", message: "Produit indisponible." };
  }
  const cart = await resolveCart();
  const result = await workflows.cart.add({
    cartId: cart.id,
    productId: product.id,
    variantId: null,
    quantity,
  });
  if (!result.ok) return { ok: false, error: result.error, message: result.message };
  // Quick-add (1-tap from a listing card) — flagged distinctly from a PDP add.
  await cartEventService
    .record({
      productId: product.id,
      quantity,
      actorKind: cart.user_id ? "client" : "visitor",
      source: "quick_add",
    })
    .catch(() => {});
  refreshCartViews();
  return { ok: true, message: "Ajouté au panier." };
}

/**
 * Quick-REMOVE by slug — the counterpart to `addToCartBySlugAction` for the
 * accessory / listing cards' "+ → ✕" toggle. Resolves the caller's own cart,
 * finds the simple-product line for this slug (the quick-add path always adds
 * with `variant_id = null`), and removes it. Idempotent: a slug already absent
 * from the cart resolves `ok` so the toggle can never wedge.
 */
export async function removeCartItemBySlugAction(slug: string): Promise<ActionState> {
  const product = await productService.findBySlug(slug);
  if (!product) return { ok: false, error: "not_found", message: "Produit introuvable." };
  const cart = await resolveCart();
  const items = await cartService.listItems(cart.id);
  // Simple-product lines store `variant_id = ""` (the column is NOT NULL DEFAULT '';
  // the quick-add path passes variantId null → add-to-cart stores ""), so match on a
  // FALSY variant_id — `== null` never matched the empty string and the toggle silently
  // failed to remove. A real variant id is a truthy uuid, so this never hits a variant line.
  const line = items.find((i) => i.product_id === product.id && !i.variant_id);
  if (!line) return { ok: true, message: "Retiré du panier." };
  const result = await workflows.cart.remove({ itemId: line.id, cartId: cart.id });
  if (!result.ok) return { ok: false, error: result.error, message: result.message };
  refreshCartViews();
  return { ok: true, message: "Retiré du panier." };
}

export async function removeCartItemAction(itemId: string): Promise<ActionState> {
  // Resolve the caller's OWN cart server-side so the workflow can verify
  // the item belongs to it. Never trust a cartId from the client.
  const cart = await resolveCart();
  const result = await workflows.cart.remove({ itemId, cartId: cart.id });
  if (!result.ok) return { ok: false, error: result.error, message: result.message };
  refreshCartViews();
  return { ok: true };
}

export async function setCartItemQuantityAction(
  itemId: string,
  quantity: number,
): Promise<ActionState> {
  const cart = await resolveCart();
  const result = await workflows.cart.setQuantity({ itemId, quantity, cartId: cart.id });
  if (!result.ok) return { ok: false, error: result.error, message: result.message };
  refreshCartViews();
  return { ok: true };
}

/** Attach (planId) or clear (null) a Tokyo Care plan on a cart line. The charge
 *  is re-validated + re-priced server-side at checkout — this only records the
 *  shopper's choice so it rides from cart → checkout. */
export async function setCartItemCarePlanAction(
  itemId: string,
  carePlanId: string | null,
): Promise<ActionState> {
  const cart = await resolveCart();
  const result = await workflows.cart.setCarePlan({ itemId, cartId: cart.id, carePlanId });
  if (!result.ok) return { ok: false, error: result.error, message: result.message };
  refreshCartViews();
  return { ok: true };
}
