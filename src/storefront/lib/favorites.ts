"use client";

import { useSyncExternalStore } from "react";

import { getWishlistSlugsAction, toggleWishlistAction } from "@/lib/actions/wishlist";

/**
 * Favourites store — backed by the BACKEND wishlist (guest cookie or signed-in
 * user), not localStorage. Keeps the exact same hook API the UI components use,
 * so the heart button, the /favoris page and the header count are unchanged;
 * only the data source moved to the backend (`toggleWishlistAction` /
 * `getWishlistSlugsAction`, which also merges a guest list into the user's on
 * login). State is a slug list, matching the unified backend slug space.
 */
let state: string[] = [];
let started = false;
let ready = false;
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((l) => l());
}
function setState(next: string[]) {
  state = next;
  emit();
}
/** Flip the one-way "initial fetch settled" flag and notify. */
function markReady() {
  if (ready) return;
  ready = true;
  emit();
}

async function hydrate() {
  if (started || typeof window === "undefined") return;
  started = true;
  try {
    setState(await getWishlistSlugsAction());
  } catch {
    /* keep empty on failure; a later toggle re-syncs */
  } finally {
    // Ready even on failure: an empty list is then the real answer, so the
    // /favoris page shows its empty state instead of a skeleton forever.
    markReady();
  }
}

/** Re-pull authoritative state from the server (after a toggle / on login). */
async function refresh() {
  try {
    setState(await getWishlistSlugsAction());
  } catch {
    /* ignore */
  }
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  void hydrate();
  return () => {
    listeners.delete(cb);
  };
}

const EMPTY: string[] = [];

export function useFavorites(): string[] {
  return useSyncExternalStore(
    subscribe,
    () => state,
    () => EMPTY,
  );
}

export function useIsFavorite(slug: string): boolean {
  return useFavorites().includes(slug);
}

export function useFavoriteCount(): number {
  return useFavorites().length;
}

/**
 * True once the initial backend wishlist fetch has settled (success OR failure).
 * The /favoris page gates its empty state on this so the "liste vide" card never
 * flashes before the server answers. False on the server and during hydration.
 */
export function useFavoritesReady(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => ready,
    () => false,
  );
}

export function toggleFavorite(slug: string) {
  void hydrate();
  // Optimistic flip, then reconcile with the server's authoritative result.
  const optimistic = state.includes(slug) ? state.filter((x) => x !== slug) : [slug, ...state];
  setState(optimistic);
  toggleWishlistAction(slug)
    .then((res) => {
      if (!res.ok) {
        void refresh(); // revert to truth on refusal (rate-limit / unavailable)
        return;
      }
      const shouldHave = res.wishlisted === true;
      const has = state.includes(slug);
      if (shouldHave !== has) {
        setState(shouldHave ? [slug, ...state.filter((x) => x !== slug)] : state.filter((x) => x !== slug));
      }
    })
    .catch(() => void refresh());
}

export function removeFavorite(slug: string) {
  if (state.includes(slug)) toggleFavorite(slug);
}

export function clearFavorites() {
  // No bulk-clear action server-side; toggle each current favourite off.
  for (const slug of [...state]) toggleFavorite(slug);
}

// (favoriteProducts removed: the /favoris view now resolves favourited products LIVE
//  via useLiveProductsBySlugs → /api/store/products, not the bundled snapshot.)
