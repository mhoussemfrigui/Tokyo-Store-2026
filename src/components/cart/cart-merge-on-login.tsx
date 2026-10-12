"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

import { mergeGuestCartAction } from "@/lib/actions/cart";

/**
 * Merges a leftover guest cart into the just-signed-in user's cart — the cart
 * counterpart of the wishlist merge in WishlistProvider. Needed because the cart
 * count + the /checkout cart are read in RSCs (readCart) that never resolve the
 * cart, so a user who logs in and goes straight to checkout would otherwise miss
 * their guest items. The shop layout renders it ONLY when it sees a signed-in
 * viewer still holding the guest cart cookie (the one case with work to do), so
 * anonymous page loads never fire the action. The server action is idempotent +
 * row-locked (safe alongside resolveCart's own merge); we only
 * `router.refresh()` when items actually moved.
 */
export function CartMergeOnLogin() {
  const router = useRouter();
  useEffect(() => {
    let active = true;
    mergeGuestCartAction()
      .then((res) => {
        if (active && res.merged) router.refresh();
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [router]);
  return null;
}
