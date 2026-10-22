import type { CSSProperties } from "react";
import { ChevronRight, type LucideIcon } from "lucide-react";
import Link from "next/link";

import { cn } from "@/storefront/lib/utils";

/**
 * Fixed, hand-picked pixel positions — never random, so the server and client
 * render the same markup. Sizes stay on whole pixels and the squares keep hard
 * corners, which is what reads as "arcade" rather than "bokeh".
 */
const PIXELS: {
  left: string;
  size: number;
  delay: string;
  /** Seconds. Scaled up in the tall bar so the longer rise reads at the same speed. */
  duration: number;
  drift: string;
  opacity: number;
  accent?: boolean;
}[] = [
  { left: "3%", size: 3, delay: "0s", duration: 4.2, drift: "8px", opacity: 0.5 },
  { left: "9%", size: 2, delay: "1.6s", duration: 5.1, drift: "-6px", opacity: 0.35 },
  { left: "15%", size: 4, delay: "0.8s", duration: 3.6, drift: "4px", opacity: 0.7, accent: true },
  { left: "22%", size: 2, delay: "2.9s", duration: 4.8, drift: "10px", opacity: 0.3 },
  { left: "29%", size: 3, delay: "1.1s", duration: 4.4, drift: "-8px", opacity: 0.45 },
  { left: "36%", size: 3, delay: "3.4s", duration: 3.9, drift: "6px", opacity: 0.6, accent: true },
  { left: "43%", size: 2, delay: "0.4s", duration: 5.4, drift: "-4px", opacity: 0.3 },
  { left: "50%", size: 4, delay: "2.2s", duration: 4.1, drift: "9px", opacity: 0.55 },
  { left: "57%", size: 2, delay: "1.9s", duration: 4.7, drift: "-7px", opacity: 0.35 },
  { left: "64%", size: 3, delay: "3.1s", duration: 3.7, drift: "5px", opacity: 0.65, accent: true },
  { left: "71%", size: 2, delay: "0.6s", duration: 5.2, drift: "-9px", opacity: 0.3 },
  { left: "78%", size: 3, delay: "2.5s", duration: 4.3, drift: "7px", opacity: 0.5 },
  { left: "85%", size: 4, delay: "1.3s", duration: 3.8, drift: "-5px", opacity: 0.6, accent: true },
  { left: "91%", size: 2, delay: "3.7s", duration: 4.9, drift: "8px", opacity: 0.35 },
  { left: "96%", size: 3, delay: "2.0s", duration: 4.5, drift: "-6px", opacity: 0.45 },
];

/**
 * The slim, full-width promo row that heads a home section — one line, never
 * tall enough to push the products below the fold. `tone` picks between the
 * crimson primary bar and the dark editorial one so two of them can sit on the
 * same page without competing.
 */
export function PromoBar({
  href,
  label,
  copy,
  meta,
  metaIcon: MetaIcon,
  tone = "primary",
  pixels = false,
  size = "slim",
}: {
  href: string;
  label: string;
  copy: string;
  /** Optional trailing chip (e.g. a real promo end date). Omitted → no chip. */
  meta?: string;
  metaIcon?: LucideIcon;
  tone?: "primary" | "dark";
  /** Arcade treatment: a drifting playfield grid and rising pixels. */
  pixels?: boolean;
  /** "tall" gives the arcade layer room to breathe; "slim" is the tuned one-liner. */
  size?: "slim" | "tall";
}) {
  const dark = tone === "dark";
  const tall = size === "tall";
  /* The pixels must clear the full height, so the taller bar gets a longer
     rise — and proportionally longer durations, or they would appear to
     speed up. */
  const rise = tall ? 148 : 76;
  const speed = tall ? 1.7 : 1;
  return (
    <Link
      href={href}
      className={cn(
        /* The transparent 1px border gives the bar the same box as the
           bordered panels, so with the pill's own inset (16 / lg:20) its
           first chip lands on the pill's logo line: 28 + 1 + 16 = 45 at md,
           49 at lg. */
        "group relative flex flex-wrap items-center gap-x-3 gap-y-2 overflow-hidden rounded-island border border-transparent shadow-island transition-colors duration-200 max-[359px]:gap-x-2 sm:flex-nowrap sm:gap-4",
        /* From sm the bar is one 24px row (chips and copy alike), centred in a
           fixed band rather than padded, so its height stays on whole pixels:
           slim is a true capsule of the pill's h-14 (56px), the same band as
           the tab strip that follows it; tall is a 96px island (h-24), room
           for the arcade layer. A min-height, not a height, so larger text
           still grows the bar. On phones both wrap to two rows and are
           28px islands. */
        tall
          ? "px-4 py-5 sm:min-h-24 sm:py-0 lg:px-5"
          : "p-4 sm:min-h-14 sm:rounded-full sm:py-0 lg:px-5",
        dark
          ? "bg-foreground text-background hover:bg-foreground/90"
          : "bg-primary text-primary-foreground hover:bg-primary-hover",
      )}
    >
      <div
        aria-hidden
        className={cn(
          "pointer-events-none absolute -right-20 -top-20 h-56 w-56 rounded-full blur-3xl",
          dark ? "bg-primary/40" : "bg-primary-foreground/10",
        )}
      />

      {/* Decorative only — the bar still reads fine with it switched off. */}
      {pixels && (
        <span
          aria-hidden
          className="pointer-events-none absolute inset-0 overflow-hidden"
          style={{ "--pixel-rise": `-${rise}px` } as CSSProperties}
        >
          <span className="tokyo-pixel-grid absolute inset-0 text-white/[0.07]" />
          {PIXELS.map((p) => (
            <span
              key={p.left}
              className={`tokyo-pixel ${p.accent ? "bg-primary" : "bg-white"}`}
              style={
                {
                  left: p.left,
                  "--pixel-size": `${p.size}px`,
                  "--pixel-delay": p.delay,
                  "--pixel-duration": `${(p.duration * speed).toFixed(2)}s`,
                  "--pixel-drift": p.drift,
                  "--pixel-opacity": p.opacity,
                } as CSSProperties
              }
            />
          ))}
        </span>
      )}

      {/* Both chips are 24px (the badge height), so row one lines up. On the
          crimson bar the label is inverted: white on crimson/20 was 4.3:1. */}
      <span
        className={cn(
          "relative inline-flex h-6 shrink-0 items-center whitespace-nowrap rounded-full px-2.5 text-[11px] font-bold tracking-[0.14em]",
          dark ? "bg-primary text-primary-foreground" : "bg-primary-foreground text-primary",
        )}
      >
        {label}
      </span>

      <p
        /* Wraps to a second line on phones instead of truncating; only
           from sm, where it fits, does it go back to one clipped line.
           Whole-pixel line boxes (20 / 24, the chips' height from sm): the
           inherited 1.5 leading made 19.5 / 22.5 / 25.5px lines and pushed
           every block below off the pixel grid. Tall's 18px is title-block. */
        className={cn(
          "relative order-3 w-full min-w-0 font-bold sm:order-none sm:w-auto sm:flex-1 sm:truncate",
          tall
            ? "text-[14px] leading-5 sm:text-lg sm:leading-6"
            : "text-[13px] leading-5 sm:text-[15px] sm:leading-6",
        )}
      >
        {copy}
      </p>

      {meta && MetaIcon && (
        <span
          /* Optional trailing chip (e.g. a real promo end date). On phones it is
             pushed to the end of row one, opposite the label. */
          className={cn(
            "relative ml-auto inline-flex h-6 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-3 text-[12px] font-semibold backdrop-blur max-[359px]:px-2.5 sm:ml-0",
            dark ? "bg-background/10" : "bg-primary-foreground/15",
          )}
        >
          <MetaIcon aria-hidden className="size-3.5 max-[359px]:hidden" />
          {meta}
        </span>
      )}

      {/* From sm only: on phones it wrapped onto a row of its own at 320, and
          the whole bar is the link anyway. */}
      <ChevronRight
        aria-hidden
        className="relative hidden size-4 shrink-0 transition-transform duration-200 group-hover:translate-x-0.5 sm:block"
      />
    </Link>
  );
}
