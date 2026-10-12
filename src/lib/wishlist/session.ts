import "server-only";

import { cookies } from "next/headers";

import { getSession } from "@/lib/auth/session";
import { wishlistService } from "@/modules/wishlist/service";
import type { WishlistRow } from "@/modules/wishlist/schema";

/**
 * Wishlist identity resolution — mirrors the cart. A signed-in user's list is
 * keyed by user_id; a guest's by a long-lived httpOnly cookie token. The guest
 * list is merged into the user's on the first authenticated read, in
 * `getWishlistSlugsAction` (src/lib/actions/wishlist.ts).
 */
export const WISHLIST_COOKIE = "gz.wishlist_token";
// 180 days, set once at creation. The retention purge of stale guest lists
// (RETENTION_WINDOWS.guest_wishlists) must never be SHORTER than this — it
// would delete a list a live cookie still points at.
const MAX_AGE = 60 * 60 * 24 * 180;

/**
 * Get-or-create the caller's wishlist. MUTATES cookies (creates a guest token
 * on first use) — only call from Server Actions / Route Handlers, never a
 * layout or RSC render (Next forbids cookie writes there).
 */
export async function resolveWishlist(): Promise<WishlistRow> {
  const session = await getSession();
  if (session?.user) {
    return (
      (await wishlistService.findByUserId(session.user.id)) ??
      (await wishlistService.createForUser(session.user.id))
    );
  }
  const jar = await cookies();
  const existing = jar.get(WISHLIST_COOKIE)?.value;
  if (existing) {
    const wl = await wishlistService.findByToken(existing);
    if (wl) return wl;
  }
  const token = crypto.randomUUID();
  const wl = await wishlistService.createForToken(token);
  jar.set(WISHLIST_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: MAX_AGE,
    path: "/",
  });
  return wl;
}

/**
 * Read-only — safe in layouts / RSC (never writes a cookie, never creates an
 * empty guest list). Returns the wishlisted product SLUGS (the client heart
 * keys by slug). Empty when there's no list yet.
 */
export async function readWishlistSlugs(): Promise<string[]> {
  const session = await getSession();
  if (session?.user) {
    const wl = await wishlistService.findByUserId(session.user.id);
    return wl ? wishlistService.listProductSlugs(wl.id) : [];
  }
  const jar = await cookies();
  const token = jar.get(WISHLIST_COOKIE)?.value;
  if (!token) return [];
  const wl = await wishlistService.findByToken(token);
  return wl ? wishlistService.listProductSlugs(wl.id) : [];
}

/** Read-only product UUIDs (for the /favoris page → product DTO lookup). */
export async function readWishlistProductIds(): Promise<string[]> {
  const session = await getSession();
  if (session?.user) {
    const wl = await wishlistService.findByUserId(session.user.id);
    return wl ? wishlistService.listProductIds(wl.id) : [];
  }
  const jar = await cookies();
  const token = jar.get(WISHLIST_COOKIE)?.value;
  if (!token) return [];
  const wl = await wishlistService.findByToken(token);
  return wl ? wishlistService.listProductIds(wl.id) : [];
}
