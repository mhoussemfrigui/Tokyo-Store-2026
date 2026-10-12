"use client";

import { useLayoutEffect } from "react";

/**
 * One-shot cleanup: strip the storefront's `dark` class off <html> so the
 * admin chrome never inherits a dark storefront view.
 *
 * The storefront dark-mode toggle sets `dark` on the SHARED <html> element.
 * When a user flips to a dark storefront page and then navigates into /admin
 * — including a back/forward bfcache restore that replays the prior DOM — the
 * stale class would otherwise bleed into the (always-light) admin chrome.
 *
 * This runs in `useLayoutEffect` so the class is removed BEFORE the browser
 * paints (no dark flash), on mount and on every bfcache restore (`pageshow`
 * with `persisted`). It renders nothing.
 *
 * Replaces the old inline `<script dangerouslySetInnerHTML>` approach, which
 * React warns about ("Scripts inside React components are never executed when
 * rendering on the client.") and which never actually ran on client navigation.
 */
export function ClearStorefrontDark() {
  useLayoutEffect(() => {
    const strip = () => document.documentElement.classList.remove("dark");
    strip();
    // bfcache restore replays the cached DOM (which may carry the dark class)
    // without re-running effects — listen for pageshow to re-strip then.
    const onPageShow = (e: PageTransitionEvent) => {
      if (e.persisted) strip();
    };
    window.addEventListener("pageshow", onPageShow);
    return () => window.removeEventListener("pageshow", onPageShow);
  }, []);

  return null;
}
