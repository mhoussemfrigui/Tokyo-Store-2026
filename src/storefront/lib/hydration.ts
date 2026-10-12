import { useSyncExternalStore } from "react";

const noopSubscribe = () => () => {};

/**
 * False on the server and during hydration, true after. The cart and the
 * favourites live in localStorage, so the server (and the hydration pass)
 * always sees them empty: views gate on this so a filled cart or favourites
 * list doesn't flash its empty state on every load.
 */
export function useHydrated(): boolean {
  return useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false,
  );
}
