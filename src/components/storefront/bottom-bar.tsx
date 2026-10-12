"use client";

import { usePathname } from "next/navigation";

/**
 * Mobile bottom-bar helpers. The storefront has ONE mobile bottom bar — the
 * global navigation pill (`MobileBottomBar`) — shown on every page except the
 * cart → checkout funnel (those own their in-flow CTAs). The matching
 * `BottomBarSpacer` reserves the pill's height so the footer/last content
 * clears it.
 *
 * (A product page used to mount a second sticky "buy bar" on the same strip,
 * coordinated through a context; that bar was removed — the product page's buy
 * actions live inline in the info column now — so the coordination is gone.)
 */

/**
 * Routes where NO bottom bar should show — the cart → checkout purchase funnel,
 * which has its own in-flow primary CTA and shouldn't carry the floating nav.
 */
export function isBottomBarHiddenRoute(pathname: string): boolean {
  return pathname === "/panier" || pathname === "/checkout";
}

/** Reserved height (excl. safe-area) for the slim nav pill. */
export const BOTTOM_BAR_SPACE = "5.25rem";

/**
 * In-flow spacer that reserves room for the bottom nav pill so the footer/last
 * content clears the fixed bar, and collapses to nothing on the cart/checkout
 * flow routes where no bar shows. Mobile-only (`lg:hidden`).
 */
export function BottomBarSpacer() {
  const pathname = usePathname();
  if (isBottomBarHiddenRoute(pathname)) return null;
  return (
    <div
      aria-hidden
      className="lg:hidden"
      style={{ height: `calc(${BOTTOM_BAR_SPACE} + env(safe-area-inset-bottom))` }}
    />
  );
}
