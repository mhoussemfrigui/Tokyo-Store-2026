"use client";

import { useLayoutEffect, useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";

import { cn } from "@/lib/utils";

// useLayoutEffect measures BEFORE paint (no flash of the late-appearing button),
// but warns during SSR — fall back to useEffect on the server.
const useIsoLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;

/**
 * SEO-safe "read more" for long sanitized HTML (product description, blog, …).
 *
 * The FULL html is ALWAYS rendered server-side into the DOM — it is only
 * VISUALLY clamped with a CSS `max-height` + `overflow:hidden` and an optional
 * fade, then a client-side button removes the clamp. Nothing is lazy-loaded,
 * conditionally rendered, or `display:none`-d, so crawlers (and no-JS readers)
 * receive the complete content; the clamp is purely cosmetic. This is the
 * Google-endorsed collapsed-content pattern — indexing is unaffected.
 *
 * The "Lire la suite" button only appears once the content is measured (after
 * mount) to actually exceed `collapsedHeight`, so short descriptions render
 * exactly as before with no button and no clamp side effects.
 */
export function CollapsibleHtml({
  html,
  className,
  collapsedHeight = 320,
  /** Tailwind gradient FROM-color matching the surrounding background. */
  fadeFromClassName = "from-background",
  moreLabel = "Lire la suite",
  lessLabel = "Réduire",
  /** Center the read-more toggle instead of left-aligning it. */
  centerToggle = false,
}: {
  html: string;
  className?: string;
  collapsedHeight?: number;
  fadeFromClassName?: string;
  moreLabel?: string;
  lessLabel?: string;
  centerToggle?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);

  useIsoLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // scrollHeight is the FULL content height even while clamped, so this stays
    // accurate. Measured synchronously (pre-paint) so the button doesn't pop in
    // a beat after load; re-measured on reflow + once web fonts settle (font
    // swap changes line wrapping and would otherwise flip the result late).
    const check = () => setOverflowing(el.scrollHeight > collapsedHeight + 40);
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    const fonts = (document as Document & { fonts?: { ready?: Promise<unknown> } }).fonts;
    fonts?.ready?.then(check).catch(() => {});
    return () => ro.disconnect();
  }, [html, collapsedHeight]);

  const clamped = overflowing && !expanded;

  return (
    <div>
      <div className="relative">
        <div
          ref={ref}
          className={className}
          // Clamp while collapsed; a short description (under the height) is
          // unaffected since max-height only caps, never stretches.
          style={expanded ? undefined : { maxHeight: collapsedHeight, overflow: "hidden" }}
          // eslint-disable-next-line react/no-danger
          dangerouslySetInnerHTML={{ __html: html }}
        />
        {clamped && (
          <div
            aria-hidden
            className={cn(
              "pointer-events-none absolute inset-x-0 bottom-0 h-20 bg-gradient-to-t to-transparent",
              fadeFromClassName,
            )}
          />
        )}
      </div>
      {overflowing && (
        <div className={cn("mt-5", centerToggle && "flex justify-center")}>
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
            className="inline-flex items-center gap-1.5 rounded-full border border-border/70 bg-card px-4 py-2 font-body text-[0.68rem] font-medium uppercase tracking-[0.15em] text-foreground transition hover:border-primary/30 hover:bg-surface"
          >
            {expanded ? lessLabel : moreLabel}
            <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", expanded && "rotate-180")} />
          </button>
        </div>
      )}
    </div>
  );
}
