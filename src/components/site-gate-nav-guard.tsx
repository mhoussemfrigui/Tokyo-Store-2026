"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";

import { isSiteGateExemptPath } from "@/lib/site-mode/gate-exempt";

/**
 * Mounted by the (shop) layout ONLY while the storefront is gated
 * (maintenance / coming-soon) and it let a gate-exempt page through (/login,
 * /reset-password, /se-desabonner…).
 *
 * Next keeps layouts across client-side navigation — the layout (and its gate)
 * does NOT re-run — so a <Link> or a server-action redirect() from such a page
 * to a gated route (/register, /, /account…) would render that route with no
 * gate. Force a full document load instead, so the layout runs again and shows
 * the maintenance scene:
 *   - same-origin link clicks to a non-exempt path are turned into hard
 *     navigations (capture phase, before the router handles them);
 *   - any other client navigation (router.push, redirect()) that lands on a
 *     non-exempt path reloads the document.
 */
export function SiteGateNavGuard() {
  const pathname = usePathname();
  const initialPath = useRef(pathname);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0) return;
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return; // new tab / window
      const a = e.target instanceof Element ? e.target.closest("a[href]") : null;
      if (!(a instanceof HTMLAnchorElement)) return;
      if ((a.target && a.target !== "_self") || a.hasAttribute("download")) return;
      const url = new URL(a.href, window.location.href);
      if (url.origin !== window.location.origin || isSiteGateExemptPath(url.pathname)) return;
      e.preventDefault();
      e.stopPropagation();
      window.location.assign(url.href);
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, []);

  useEffect(() => {
    // Only after an actual navigation (never on mount — no reload loop).
    if (pathname !== initialPath.current && !isSiteGateExemptPath(pathname)) {
      window.location.reload();
    }
  }, [pathname]);

  return null;
}
