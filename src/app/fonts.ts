import { Playfair_Display, Montserrat, DM_Sans, JetBrains_Mono } from "next/font/google";

/**
 * Storefront typography — the high-tech aesthetic.
 *  - Playfair Display (serif) → headings / brand wordmark.
 *  - Montserrat (sans)        → body / UI / buttons.
 *  - DM Sans                  → secondary sans (numerics, captions).
 *
 * These are loaded once in the root layout and exposed as CSS variables.
 * They are applied storefront-only via the `.storefront` scope in globals.css,
 * so the admin panel keeps its own Manrope font.
 */
export const fontPlayfair = Playfair_Display({
  subsets: ["latin"],
  variable: "--font-playfair",
  display: "swap",
  weight: ["400", "500", "600", "700"],
});

export const fontMontserrat = Montserrat({
  subsets: ["latin"],
  variable: "--font-montserrat",
  display: "swap",
  weight: ["300", "400", "500", "600", "700"],
});

export const fontDmSans = DM_Sans({
  subsets: ["latin"],
  variable: "--font-dm-sans",
  display: "swap",
});

/**
 * JetBrains Mono — the monospace face for code/diagnostic text (the error-page
 * reference, stack trace + meta table, and any `font-mono` usage). Loaded once
 * here, exposed as `--font-jetbrains-mono`, and wired to Tailwind `font-mono`
 * via the `@theme` block in globals.css.
 */
export const fontJetBrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains-mono",
  display: "swap",
  weight: ["400", "500", "600"],
});
