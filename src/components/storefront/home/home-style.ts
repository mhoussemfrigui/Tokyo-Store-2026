/**
 * Home « soft luxury » class tokens — shared by the server block renderer and the client
 * hero / rail. A plain module (no "use client", no JSX) so the server renderer receives
 * real strings, and literal class strings so Tailwind's source scan generates them.
 *
 * The language: the photograph, the serif and the lit vitrine carry the luxury; controls,
 * numbers and effects step back. Gold is jewellery — the italic accent line (kit Title)
 * and the kit eyebrow's hairline only. One button (the outline pill, `secondary`), one link
 * (underlined small caps), one card label, one easing, one slow cue per hover.
 */

/** The one easing for every home transition. */
export const EASE = "ease-[cubic-bezier(0.22,0.61,0.36,1)]";

/** The italic accent line over a photograph — a desaturated champagne, a clear second voice. */
export const ON_PHOTO_ACCENT = "text-[hsl(33_30%_80%)]";

/** Secondary link over a photograph — same caps register as the md outline pill beside it. */
export const ON_PHOTO_LINK =
  "group inline-flex min-h-6 items-center rounded-[2px] font-body text-[0.72rem] uppercase tracking-[0.16em] text-white/90 transition-colors duration-500 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-white";
/** Its underline. */
export const ON_PHOTO_LINK_LABEL = "border-b border-white/35 pb-1 transition-colors duration-500 group-hover:border-white/80";

/** The quiet continuation link (« Voir tout », « Toutes les marques »). */
export const QUIET_LINK =
  "group -my-2.5 inline-flex min-h-6 items-center gap-2 rounded-[2px] py-2.5 font-body text-[0.68rem] uppercase tracking-[0.2em] text-foreground/80 transition-colors duration-500 hover:text-foreground focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-4 focus-visible:outline-foreground/80 lg:my-0 lg:py-0";
/** Its underline. */
export const QUIET_LINK_LABEL = "border-b border-foreground/25 pb-1 transition-colors duration-500 group-hover:border-foreground/60";
/** Its hairline arrow — a 2px drift on hover, nothing under reduced motion. */
export const QUIET_LINK_ARROW =
  "h-3 w-3 opacity-60 transition-[translate,opacity] duration-500 ease-[cubic-bezier(0.22,0.61,0.36,1)] group-hover:opacity-100 motion-safe:group-hover:translate-x-0.5";

/** The single caps label a card may carry (its eyebrow / tag). */
export const CARD_LABEL = "font-body text-[0.64rem] uppercase tracking-[0.24em] text-muted-foreground";
/** Card meta (price / badge) — serif, in ink, never gold. */
export const CARD_META = "font-serif text-base tabular-nums text-foreground/75";
/** A card's own CTA label (only when the operator wrote one). */
export const CARD_CTA =
  "inline-block border-b border-foreground/25 pb-1 font-body text-[0.66rem] uppercase tracking-[0.2em] text-foreground/75 transition-colors duration-500 group-hover:border-foreground/60 group-hover:text-foreground";

/** The home's ONE soft panel material (`--tk-home-panel`, globals.css): ladder cards,
 *  the brand-tile hover, the no-image CTA. A hairline frame, one greige fill. */
export const PANEL = "rounded-[1.75rem] border border-border/60 bg-[var(--tk-home-panel)]";

/** Grid gaps — cards whose copy sits BELOW the visual (vitrine duo, categories, steps, trust). */
export const GRID_GAP_CARDS = "gap-x-5 gap-y-12 md:gap-x-6 lg:gap-x-8";
/** Grid gaps — self-contained tiles (complications, banner duo). */
export const GRID_GAP_TILES = "gap-5 md:gap-6 lg:gap-8";
