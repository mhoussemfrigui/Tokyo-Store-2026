"use client";

import { useEffect } from "react";

/**
 * Tiny client island that calls `window.print()` once after mount when the
 * invoice page was loaded with `?autoprint=1`. Lives in its own file so the
 * invoice itself stays a server component (no client-bundle overhead for
 * admins who only need to view the page).
 */
export function AutoPrint() {
  useEffect(() => {
    // Defer a tick so styles / fonts have a chance to settle.
    const t = setTimeout(() => window.print(), 100);
    return () => clearTimeout(t);
  }, []);
  return null;
}
