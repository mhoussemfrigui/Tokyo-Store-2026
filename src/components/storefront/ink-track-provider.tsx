"use client";

import { useEffect } from "react";

/**
 * Global ink-track driver — a single passive `mousemove` listener on the
 * document that, for whatever `.ink-track` element the cursor is over, writes
 * `--ink-x`/`--ink-y` (in px, relative to that element) so the CSS radial-glow
 * in `globals.css` follows the cursor. Mounted once in the (shop) layout.
 *
 * Faithful port of the source `useGlobalInkTrack` hook.
 */
export function InkTrackProvider() {
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      const el = target?.closest?.(".ink-track") as HTMLElement | null;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      el.style.setProperty("--ink-x", `${e.clientX - rect.left}px`);
      el.style.setProperty("--ink-y", `${e.clientY - rect.top}px`);
    };
    document.addEventListener("mousemove", handler, { passive: true });
    return () => document.removeEventListener("mousemove", handler);
  }, []);

  return null;
}
