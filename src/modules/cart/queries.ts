import "server-only";

import { eq, sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { products } from "@/modules/catalog/product/schema";
import { cart_items, carts } from "./schema";

/**
 * SQL-aggregated cart roll-up.
 *
 * Pushes the SUM down to Postgres instead of pulling every row across the
 * wire and reducing in JS — one row over the wire regardless of cart size.
 * COALESCE keeps an empty cart returning 0 instead of NULL, and `::int`
 * forces the SUM out as a plain integer so node-postgres doesn't hand back
 * a string for the BIGINT default.
 *
 * NB: `subtotalCents` sums the ADD-TIME `unit_price_cents` (stale once an
 * auto-promo ends / starts or a base price changes) — fine for the header item
 * count, never for pricing or coupon gating: use `@/lib/cart/live-lines`
 * (`priceCartLinesLive`), the basis the cart pages and place-order use.
 */
export async function getCartSummary(cartId: string) {
  const [row] = await db
    .select({
      subtotalCents: sql<number>`COALESCE(SUM(${cart_items.quantity} * ${cart_items.unit_price_cents}), 0)::int`.mapWith(Number),
      itemCount: sql<number>`COALESCE(SUM(${cart_items.quantity}), 0)::int`.mapWith(Number),
    })
    .from(cart_items)
    .where(eq(cart_items.cart_id, cartId));

  return {
    itemCount: row?.itemCount ?? 0,
    subtotalCents: row?.subtotalCents ?? 0,
  };
}

/**
 * A user's live cart, hydrated with product name/slug for the admin customer
 * 360 ("panier actuel"). Returns null when the user has no cart. Lines keep
 * their add-time `unit_price_cents` (what the customer would pay); the subtotal
 * is summed in JS off the (already small) line set. `variantId` is surfaced so
 * the admin can see a variant was chosen even though we don't resolve its label
 * here.
 */
export async function getUserCartForAdmin(userId: string): Promise<{
  cartId: string;
  currency: string;
  updatedAt: Date;
  items: Array<{
    productId: string;
    variantId: string;
    name: string | null;
    slug: string | null;
    quantity: number;
    unitPriceCents: number;
  }>;
  subtotalCents: number;
} | null> {
  const [cart] = await db.select().from(carts).where(eq(carts.user_id, userId)).limit(1);
  if (!cart) return null;
  const items = await db
    .select({
      productId: cart_items.product_id,
      variantId: cart_items.variant_id,
      name: products.name,
      slug: products.slug,
      quantity: cart_items.quantity,
      unitPriceCents: cart_items.unit_price_cents,
    })
    .from(cart_items)
    .leftJoin(products, eq(products.id, cart_items.product_id))
    .where(eq(cart_items.cart_id, cart.id))
    .orderBy(sql`${cart_items.created_at} desc`);
  const subtotalCents = items.reduce((s, i) => s + i.quantity * i.unitPriceCents, 0);
  return { cartId: cart.id, currency: cart.currency, updatedAt: cart.updated_at, items, subtotalCents };
}
