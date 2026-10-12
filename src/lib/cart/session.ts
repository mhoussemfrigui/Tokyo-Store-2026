import "server-only";

import { cookies } from "next/headers";
import { randomBytes } from "node:crypto";

import { cartService } from "@/modules/cart/service";
import { getSession } from "@/lib/auth/session";

export const CART_COOKIE = "gz.cart_token";
// Set once at creation. The retention purge of stale guest carts
// (RETENTION_WINDOWS.guest_carts, keyed on last activity) must stay LONGER than
// this so it never deletes a cart a live cookie still points at.
const COOKIE_TTL_DAYS = 30;

/**
 * READ-ONLY cart lookup safe for Server Components / Layouts.
 *
 * Unlike `resolveCart()`, this never writes a cookie or inserts a row —
 * Next.js disallows cookie writes during page/layout rendering. Returns
 * `null` when no cart exists yet; callers treat that as "empty cart".
 *
 * The cookie + row are created lazily the first time the user actually
 * mutates the cart (via `addToCartAction` → `resolveCart()`).
 */
export async function readCart() {
  const session = await getSession();
  if (session?.user) {
    return cartService.findByUserId(session.user.id);
  }
  const jar = await cookies();
  const token = jar.get(CART_COOKIE)?.value;
  if (!token) return null;
  return cartService.findByToken(token);
}

/**
 * Resolve the current cart for the request.
 *
 *   - If signed in → returns the user's cart, creating it on first call.
 *   - Otherwise → uses an anonymous token from the cookie, creating one
 *     (and the cookie) if missing.
 *
 * Cookie writes are only allowed in Server Actions / Route Handlers —
 * never call from a layout or page render. Use `readCart()` there.
 */
export async function resolveCart() {
  const session = await getSession();
  if (session?.user) {
    // Merge a leftover guest cart into the user cart on the first authenticated
    // resolve (the schema's documented hand-off). Idempotent + row-locked, so
    // it's safe alongside the shop-layout mount trigger; the cookie is dropped
    // after so it runs once.
    const jar = await cookies();
    const guestToken = jar.get(CART_COOKIE)?.value;
    if (guestToken) {
      await cartService.mergeGuestCart(guestToken, session.user.id).catch(() => {});
      jar.delete(CART_COOKIE);
    }
    // Idempotent: two concurrent first-resolves for a brand-new session race to
    // create the single user cart; getOrCreateForUser absorbs the loser's
    // unique-violation and re-fetches instead of 500-ing (VULN-3).
    return cartService.getOrCreateForUser(session.user.id);
  }

  const jar = await cookies();
  let token = jar.get(CART_COOKIE)?.value;
  if (token) {
    const existing = await cartService.findByToken(token);
    if (existing) return existing;
  }
  token = randomBytes(24).toString("base64url");
  const cart = await cartService.createCart({ token });
  jar.set(CART_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: COOKIE_TTL_DAYS * 24 * 60 * 60,
  });
  return cart;
}
