import type { ThemeDarkMode } from "@/lib/theme/config";

/**
 * Storefront dark-mode pre-paint resolution — shared by the (shop) layout's
 * inline init script and the footer `DarkModeToggle` (which persists the
 * visitor's explicit choice under the same key). Isomorphic: a type-only import
 * of the server theme config, so the client toggle can import the key.
 */

/** localStorage key holding the visitor's explicit choice ("dark" | "light"). */
export const DARK_MODE_STORAGE_KEY = "gz-theme";

/**
 * Inline script that sets the `dark` class on <html> BEFORE paint. Resolution:
 *   1. admin mode "off" (« Désactivé (clair uniquement) ») ⇒ ALWAYS light. The
 *      toggle is hidden in that mode, so a "dark" saved while the mode was
 *      on/system must not strand the visitor on the dark palette with no way
 *      back. The saved choice is left in storage, so it applies again if the
 *      admin re-enables dark mode;
 *   2. otherwise the visitor's saved choice wins;
 *   3. otherwise the admin default ("on" ⇒ dark, "system" ⇒ OS preference).
 * `mode` is a validated enum (off|system|on), so embedding it via
 * JSON.stringify is injection-safe.
 */
export function buildDarkModeInitJs(mode: ThemeDarkMode): string {
  return `(function(){try{var m=${JSON.stringify(mode)};var s=localStorage.getItem(${JSON.stringify(DARK_MODE_STORAGE_KEY)});var d=m!=="off"&&(s==="dark"||(s!=="light"&&(m==="on"||(m==="system"&&window.matchMedia("(prefers-color-scheme:dark)").matches))));document.documentElement.classList.toggle("dark",d);}catch(e){}})();`;
}
