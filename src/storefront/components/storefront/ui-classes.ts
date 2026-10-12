/**
 * Shared class recipes for the storefront's control language, derived from the
 * reference nav pill: capsules, 13px semibold labels, 44px icon buttons, crimson
 * as a tint at rest and solid only when selected / for the one primary CTA.
 * Compose with cn() from "@/storefront/lib/utils": cn(btn.base, btn.lg, btn.primary, "w-full").
 * Never override a size recipe's height/padding; pick another size instead.
 */
export const btn = {
  base: "inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-full font-semibold transition-colors duration-200 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60",
  /** 40px (44px on touch) — card-level CTAs, toolbar actions. */
  sm: "h-10 px-4 text-[13px] pointer-coarse:h-11",
  /** 44px — default, docked/sticky bars, secondary actions. */
  md: "h-11 px-5 text-sm",
  /** 48px — page CTAs: order summary, empty states, 404, newsletter. */
  lg: "h-12 px-6 text-[15px] font-bold",
  /** 56px (the pill's height) — product page buy box only. */
  xl: "h-14 px-7 text-[15px] font-bold",
  primary: "bg-primary text-primary-foreground shadow-cta hover:bg-primary-hover",
  ink: "bg-foreground text-background hover:bg-primary",
  soft: "bg-primary/10 text-primary-ink hover:bg-primary/15",
  outline:
    "border border-border bg-background text-foreground hover:border-primary/40 hover:text-primary",
  ghost: "text-graphite hover:bg-secondary hover:text-foreground",
} as const;

export const iconBtn = {
  base: "grid size-11 shrink-0 place-items-center rounded-full transition-colors duration-200",
  ghost: "text-foreground hover:bg-secondary",
  outline:
    "border border-border bg-background text-foreground hover:border-primary/40 hover:text-primary",
  glass:
    "border border-border bg-background/80 text-foreground shadow-sm backdrop-blur-md hover:bg-background hover:text-primary disabled:pointer-events-none disabled:opacity-40",
} as const;

export const chip = {
  base: "inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full text-[13px] transition-colors duration-200",
  /** 32px — inline chips (breadcrumb, desktop filters, related searches). Add `hit-44` for touch. */
  sm: "h-8 px-3",
  /** 44px — chips in sheets, menus and touch rows. */
  lg: "h-11 px-4",
  neutral:
    "border border-border bg-background font-medium text-graphite hover:border-primary/40 hover:text-primary",
  accent: "bg-primary/10 font-semibold text-primary-ink hover:bg-primary/15",
  selected: "pill-gloss border border-transparent bg-primary font-semibold text-primary-foreground",
} as const;

export const badge = {
  base: "inline-flex h-6 shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-2.5 text-[12px] font-semibold tabular-nums",
  discount: "bg-primary font-bold text-primary-foreground",
  success: "bg-success/10 text-success",
  accent: "bg-primary/10 text-primary-ink",
  neutral: "bg-secondary text-graphite",
  muted: "bg-muted text-muted-foreground",
  inverse: "bg-foreground/85 font-bold text-background",
} as const;

/** Island (28px panel) and card (24px) surfaces; panels pad like the pill so text lands on the logo line. */
export const panel = "rounded-island border border-border bg-background shadow-island";
export const panelPad = "p-4 lg:p-5";
export const card = "rounded-card border border-border bg-background shadow-island";

/**
 * The floating 56px capsule (pill family: mobile header row, search overlay,
 * category filter capsule, product sticky bar). 1px hairline + 5px padding
 * puts 44px controls 6px inside the outer edge on every side, concentric with
 * the 28px radius. Add the shadow for the layer (float / pill).
 */
export const capsuleBar =
  "flex h-14 items-center rounded-full border border-border bg-background/95 px-[5px] backdrop-blur-xl";

/** 40px accent disc for icon + label rows and tiles (decorative, not a target). */
export const iconDisc =
  "grid size-10 shrink-0 place-items-center rounded-full bg-primary/10 text-primary";

/**
 * The reassurance tile (home promises, category guarantees, product
 * services): disc on the left, 15px display title, 13px copy. Compose `tile`
 * with `card`, or with bg-background inside a hairline-grid island.
 */
export const promise = {
  tile: "flex items-start gap-3 p-4 lg:gap-4 lg:p-5",
  disc: iconDisc,
  title: "font-display text-[15px] font-bold leading-snug text-foreground",
  copy: "mt-1 text-[13px] leading-relaxed text-muted-foreground",
} as const;

/**
 * Form fields. Focus is the site's 2px ring-colour outline, laid over the 1px
 * border (-1 offset), plus a soft halo: the border colour alone could not
 * carry it, since an invalid field is already red (destructive ≈ primary) and
 * a focused invalid field differed from an unfocused one only by the 15% halo.
 */
export const field =
  "h-12 w-full rounded-full border border-muted-foreground/70 bg-background px-4 text-base text-foreground transition-[border-color,box-shadow] duration-200 placeholder:text-muted-foreground focus-visible:border-primary focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-ring focus-visible:ring-4 focus-visible:ring-primary/15 aria-[invalid=true]:border-destructive md:text-[15px]";
/** Multi-line `field`: the nested radius instead of the capsule (a resize grip would sit inside the curve, so none). */
export const fieldArea =
  "min-h-24 w-full resize-none rounded-inner border border-muted-foreground/70 bg-background px-4 py-3 text-base text-foreground transition-[border-color,box-shadow] duration-200 placeholder:text-muted-foreground focus-visible:border-primary focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-ring focus-visible:ring-4 focus-visible:ring-primary/15 aria-[invalid=true]:border-destructive md:text-[15px]";
export const fieldLabel = "mb-1.5 block pl-1 text-[13px] font-semibold text-foreground";

/**
 * Selectable option tiles (reception mode, pickup store, payment, Tokyo Care
 * plans): hairline at rest; the choice is a tint plus a 1px ring on the 1px
 * border, i.e. 2px of crimson. Pair with aria-pressed (buttons) or a radio.
 * Capsule-shaped options add `rounded-full` (cn() lets it win).
 */
export const option = {
  base: "rounded-inner border text-left transition-colors duration-200",
  rest: "border-border bg-background hover:border-primary/40",
  selected: "border-primary bg-primary/5 ring-1 ring-primary",
  /** 12px inset of every option tile (cart Tokyo Care plans, checkout reception/store/payment). */
  pad: "p-3",
} as const;

/** Vertical rhythm (4px grid). */
export const rhythm = {
  section: "mt-14 sm:mt-16 lg:mt-20",
  head: "mt-5 sm:mt-6 lg:mt-8",
  island: "mt-3 sm:mt-5 lg:mt-6",
  gap: "gap-3 sm:gap-5 lg:gap-6",
  stack: "space-y-3 sm:space-y-5 lg:space-y-6",
} as const;
