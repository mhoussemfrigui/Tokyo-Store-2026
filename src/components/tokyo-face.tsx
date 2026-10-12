"use client";

import { useEffect, useRef, useState } from "react";

/**
 * The Tokyo mascot face — the crimson-era centrepiece shared by the 404 and
 * maintenance scenes (replaces the olive AnimatedClock). A friendly round face
 * inside a beige disc with a slowly-spinning dashed ring: the pupils (and the
 * whole face, subtly) follow the cursor, the eyes blink on a gentle cycle, and a
 * crimson badge — a "?" for 404 or a wrench for maintenance — pops in on load.
 *
 * Self-contained: it tracks the pointer against its OWN centre (via a window
 * listener), so a caller just drops it in at any size. Fully decorative
 * (`aria-hidden`) and motion-safe — under `prefers-reduced-motion` the pointer
 * tracking + blink stand down (JS) and the ring spin + badge pop are held still
 * (CSS @media), leaving a calm static face. The badge pop is CSS, so it also shows
 * correctly with JavaScript disabled (it rests visible at scale 1).
 *
 * The `badge` prop also selects the per-scene nuances the mockups specify: the 404
 * "?" badge sits at 8%/4% and is a touch smaller + the face tracks the cursor a bit
 * further, while the maintenance wrench sits at 6%/2% and is a touch larger.
 *
 * Size comes from the caller's `className` (set width/height); everything inside
 * scales to it with percentages, exactly like the mockup.
 */
export function TokyoFace({
  badge,
  className,
}: {
  /** The crimson corner badge: a question mark (404) or a wrench (maintenance). */
  badge?: "question" | "wrench";
  /** Caller sizes the face here (e.g. "h-44 w-44"). */
  className?: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const [{ mx, my }, setPos] = useState({ mx: 0, my: 0 });
  const [blink, setBlink] = useState(false);

  useEffect(() => {
    const reduce =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    // The ring spin + badge pop are CSS (motion-safe). Only the cursor tracking +
    // blink need JS — both stand down under reduced motion.
    if (reduce) return;

    // Pupils + face follow the cursor, normalised against the face's own centre
    // (clamped to ±1 over ~520px), so the face "looks at" the pointer anywhere.
    const R = 520;
    const onMove = (e: PointerEvent) => {
      const el = ref.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const clamp = (v: number) => Math.max(-1, Math.min(1, v));
      setPos({ mx: clamp((e.clientX - cx) / R), my: clamp((e.clientY - cy) / R) });
    };
    const reset = () => setPos({ mx: 0, my: 0 });
    window.addEventListener("pointermove", onMove, { passive: true });
    window.addEventListener("pointerleave", reset);
    const cyc = window.setInterval(() => {
      setBlink(true);
      window.setTimeout(() => setBlink(false), 140);
    }, 3300);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerleave", reset);
      window.clearInterval(cyc);
    };
  }, []);

  const is404 = badge === "question";
  // Per-scene parallax magnitudes (404 tracks a touch further — mockup oX/iX).
  const outer = is404 ? 14 : 12;
  const inner = is404 ? 18 : 16;

  const px = `${mx * 60}%`;
  const py = `${my * 60}%`;
  const pupil = (
    <span
      className="absolute left-1/2 top-1/2 h-[46%] w-[46%] rounded-full bg-[#0e1218]"
      style={{ margin: "-23% 0 0 -23%", transform: `translate(${px}, ${py})`, transition: "transform .25s cubic-bezier(.2,.8,.2,1)" }}
    >
      <span className="absolute right-[18%] top-[18%] h-[28%] w-[28%] rounded-full bg-white" />
    </span>
  );
  const eye = (
    <span
      className="relative aspect-square w-[24%] overflow-hidden rounded-full bg-white shadow-[inset_0_0_0_2px_#e6dfd7]"
      style={{ transform: `scaleY(${blink ? 0.1 : 1})`, transition: "transform .12s ease" }}
    >
      {pupil}
    </span>
  );

  return (
    <span
      ref={ref}
      aria-hidden
      className={`relative flex shrink-0 items-center justify-center rounded-full bg-[#f6f2ed] ${className ?? ""}`}
      style={{ transform: `translate(${mx * outer}px, ${my * outer}px)`, transition: "transform .5s cubic-bezier(.2,.8,.2,1)" }}
    >
      {/* Slowly-spinning dashed ring (motion-safe). */}
      <span className="tokyo-face-ring absolute -inset-[10px] rounded-full border-2 border-dashed border-[#e6dfd7]" />

      {/* Eyes + mouth + cheeks, nudged toward the cursor. */}
      <span
        className="absolute inset-0 flex flex-col items-center justify-center gap-[9%]"
        style={{ transform: `translate(${mx * inner}px, ${my * inner}px)`, transition: "transform .5s cubic-bezier(.2,.8,.2,1)" }}
      >
        <span className="flex w-full justify-center gap-[12%]">
          {eye}
          {eye}
        </span>
        <span className="h-[7%] w-[22%] rounded-full bg-[#0e1218]" />
        <span className="absolute left-[14%] top-[55%] h-[6%] w-[12%] rounded-full bg-[#f9b8c4] opacity-0" />
        <span className="absolute right-[14%] top-[55%] h-[6%] w-[12%] rounded-full bg-[#f9b8c4] opacity-0" />
      </span>

      {/* Crimson corner badge — CSS pop-in; per-scene placement + size (mockup). */}
      {badge && (
        <span
          className="tokyo-badge-pop absolute grid aspect-square place-items-center rounded-full bg-[#d40530] text-white shadow-[0_8px_20px_rgba(212,5,48,.35)]"
          style={{
            top: is404 ? "8%" : "6%",
            right: is404 ? "4%" : "2%",
            width: is404 ? "clamp(26px,4vw,44px)" : "clamp(30px,4.4vw,48px)",
            height: is404 ? "clamp(26px,4vw,44px)" : "clamp(30px,4.4vw,48px)",
          }}
        >
          {is404 ? (
            <span className="text-[clamp(14px,2vw,22px)] font-black leading-none">?</span>
          ) : (
            <svg viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" className="h-[55%] w-[55%]">
              <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
            </svg>
          )}
        </span>
      )}
    </span>
  );
}
