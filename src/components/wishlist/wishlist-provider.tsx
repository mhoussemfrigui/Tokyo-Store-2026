"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";

import { getWishlistSlugsAction, toggleWishlistAction } from "@/lib/actions/wishlist";

/**
 * Client wishlist state. Loads the current wishlisted product SLUGS once on
 * mount (one server action) and exposes optimistic toggle + membership checks
 * so every heart on the page stays in sync without prop-drilling. Cards/PDP key
 * by slug because the public Product DTO doesn't carry the DB id.
 */
type WishlistContextValue = {
  has: (slug: string) => boolean;
  toggle: (slug: string) => void;
  count: number;
  ready: boolean;
};

const WishlistContext = createContext<WishlistContextValue | null>(null);

export function WishlistProvider({ children }: { children: React.ReactNode }) {
  const [slugs, setSlugs] = useState<Set<string>>(new Set());
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let active = true;
    getWishlistSlugsAction()
      .then((arr) => {
        if (active) setSlugs(new Set(arr));
      })
      .catch(() => {})
      .finally(() => {
        if (active) setReady(true);
      });
    return () => {
      active = false;
    };
  }, []);

  const has = useCallback((slug: string) => slugs.has(slug), [slugs]);

  const toggle = useCallback((slug: string) => {
    // Optimistic flip.
    setSlugs((prev) => {
      const next = new Set(prev);
      if (next.has(slug)) next.delete(slug);
      else next.add(slug);
      return next;
    });
    toggleWishlistAction(slug)
      .then((res) => {
        if (!res.ok) {
          // Revert the optimistic flip on failure.
          setSlugs((prev) => {
            const next = new Set(prev);
            if (next.has(slug)) next.delete(slug);
            else next.add(slug);
            return next;
          });
        } else if (typeof res.wishlisted === "boolean") {
          // Reconcile to the server's truth.
          setSlugs((prev) => {
            const next = new Set(prev);
            if (res.wishlisted) next.add(slug);
            else next.delete(slug);
            return next;
          });
        }
      })
      .catch(() => {});
  }, []);

  return (
    <WishlistContext.Provider value={{ has, toggle, count: slugs.size, ready }}>
      {children}
    </WishlistContext.Provider>
  );
}

export function useWishlist(): WishlistContextValue | null {
  return useContext(WishlistContext);
}
