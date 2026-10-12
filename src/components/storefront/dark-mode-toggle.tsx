"use client";

import { useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";

import { DARK_MODE_STORAGE_KEY } from "@/lib/theme/dark-mode-init";

/**
 * Storefront light/dark toggle. The initial class is set BEFORE paint by the
 * inline theme-init script in the shop layout (buildDarkModeInitJs: admin "off"
 * ⇒ light, else localStorage → admin default → system preference), so this
 * only needs to read the current state on mount and flip it on click,
 * persisting the visitor's explicit choice.
 *
 * Rendered only when the admin dark-mode setting is not "off" (the footer
 * gates it) — so a light-only store shows no toggle, and the init script then
 * ignores any choice saved earlier (it is kept for when dark mode returns).
 */
export function DarkModeToggle() {
  const [dark, setDark] = useState(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    // Sync from the class the pre-paint init script set — only knowable on the
    // client, so reading it on mount is correct (not derivable during SSR).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDark(document.documentElement.classList.contains("dark"));
    setReady(true);
  }, []);

  function toggle() {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle("dark", next);
    try {
      localStorage.setItem(DARK_MODE_STORAGE_KEY, next ? "dark" : "light");
    } catch {
      /* private mode / storage disabled — the class still flips for this view */
    }
  }

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={dark ? "Passer en thème clair" : "Passer en thème sombre"}
      // suppressHydrationWarning: the icon depends on the pre-paint class, which
      // the server can't know — it settles on mount without a layout shift.
      suppressHydrationWarning
      className="inline-flex items-center gap-1.5 rounded-full border border-border px-3 py-1 text-xs font-medium text-muted-foreground transition hover:border-foreground/30 hover:text-foreground"
    >
      {ready && dark ? <Sun className="h-3.5 w-3.5" strokeWidth={2} /> : <Moon className="h-3.5 w-3.5" strokeWidth={2} />}
      <span suppressHydrationWarning>{ready && dark ? "Clair" : "Sombre"}</span>
    </button>
  );
}
