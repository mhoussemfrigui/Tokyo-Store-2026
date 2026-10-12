"use client";

import Image from "next/image";
import { useCallback, useEffect, useRef, useState } from "react";
import { Pause, Play } from "lucide-react";

import type { ProductImage } from "@/types/catalog";
import { buttonVariants } from "@/components/ui/button";
import { BANNER_BUTTON_STYLE, type BannerButton } from "@/lib/cms/banner-model";
import { cn } from "@/lib/utils";
import { SECTION_CONTAINER } from "@/lib/pages/block-model";
import { SmartLink } from "@/components/storefront/page/blocks/kit";
import { track } from "@/lib/tracking/funnel";
import { EASE, ON_PHOTO_ACCENT, ON_PHOTO_LINK, ON_PHOTO_LINK_LABEL } from "./home-style";

export type HomeHeroSlide = {
  eyebrow: string;
  title: string;
  subtitle: string;
  description: string;
  /** Editable CTAs (design-chosen) — already sanitised/safe-href'd at the read seam. */
  buttons: BannerButton[];
  image: ProductImage | null;
  /** Optional art-directed MOBILE visual (portrait crop). Shown below the `sm`
   *  breakpoint; when null the desktop `image` is used at every width. */
  imageMobile: ProductImage | null;
  /** Optional médiathèque VIDEO (muted/looped, `image` is the poster/fallback). */
  video: string | null;
  imageAlt: string | null;
  /** false = pure image/video slide (no text/button overlay); the whole slide
   *  links to the first button's target when one is set. The headline stays in
   *  the DOM (visually hidden) so the page keeps its <h1>. */
  showText: boolean;
};

/** The on-photo link treatment (quiet underline) used for a `link`-design button. */
function isLinkDesign(variant: BannerButton["variant"]): boolean {
  return variant === "link";
}

const AUTOPLAY_MS = 9000;

/** Display typography: never break a compound at its hyphen (« garde- / temps »). Each
 *  hyphenated word is kept whole; ordinary spaces still wrap (and text-balance still balances). */
function keepCompounds(text: string): React.ReactNode {
  if (!text.includes("-")) return text;
  return text.split(/(\s+)/).map((part, i) =>
    /\S-\S/.test(part) ? (
      <span key={i} className="whitespace-nowrap">
        {part}
      </span>
    ) : (
      part
    ),
  );
}

/**
 * Quiet full-bleed homepage hero. A serif h1 whose second line (the slide subtitle) is a
 * desaturated champagne italic; one outline pill + one underlined link. The photographs
 * crossfade slowly and settle from an almost imperceptible drift.
 *
 * Chrome recedes: the slide pickers are ivory hairline dashes plus a small pause glyph —
 * no counter, labels, arrows or progress bar. Autoplay is an INVISIBLE CSS timer (its
 * `animationend` advances), held via `animation-play-state` while hovered, focused or
 * offscreen; reduced motion removes the animation, so nothing auto-advances there. Any
 * visitor navigation (dash, swipe, ←/→) stops the rotation for good (WCAG 2.2.2 / APG);
 * the pause glyph toggles it. Slides come resolved from Bannières (placement home_hero).
 */
export function HomeHero({ slides }: { slides: HomeHeroSlide[] }) {
  const count = slides.length;
  const [current, setCurrent] = useState(0);
  const [stopped, setStopped] = useState(false); // visitor pause — sticky until « Reprendre »
  const [hovered, setHovered] = useState(false); // transient holds
  const [focused, setFocused] = useState(false);
  const [offscreen, setOffscreen] = useState(false);
  // False until the first change, so the first paint (the LCP) has no entrance delay.
  const [navigated, setNavigated] = useState(false);
  // Announced ONLY on visitor navigation — timer changes stay silent.
  const [announce, setAnnounce] = useState("");
  const sectionRef = useRef<HTMLElement>(null);

  const advance = useCallback(() => {
    setNavigated(true);
    setCurrent((p) => (p + 1) % count);
  }, [count]);
  const select = useCallback(
    (i: number) => {
      setStopped(true);
      setNavigated(true);
      setCurrent(i);
      setAnnounce(`Diapositive ${i + 1} sur ${count}`);
    },
    [count],
  );
  const step = useCallback(
    (d: 1 | -1) => {
      const n = ((current < count ? current : 0) + d + count) % count;
      setStopped(true);
      setNavigated(true);
      setCurrent(n);
      setAnnounce(`Diapositive ${n + 1} sur ${count}`);
    },
    [count, current],
  );
  const toggle = () => {
    // « Reprendre » takes effect at once, even with the pointer / focus still inside.
    if (stopped) {
      setHovered(false);
      setFocused(false);
    }
    setStopped(!stopped);
  };

  // Hold the timer while the hero is scrolled away or the tab is hidden, so a visitor
  // never comes back to a slide that changed out of sight.
  useEffect(() => {
    const el = sectionRef.current;
    if (!el || count <= 1) return;
    let vis = document.visibilityState !== "hidden";
    let seen = true;
    const sync = () => setOffscreen(!(vis && seen));
    const io =
      typeof IntersectionObserver !== "undefined"
        ? new IntersectionObserver(
            ([e]) => {
              seen = e.isIntersecting;
              sync();
            },
            { threshold: 0.25 },
          )
        : null;
    io?.observe(el);
    const onVis = () => {
      vis = document.visibilityState !== "hidden";
      sync();
    };
    // No synchronous sync() here: the observer's initial callback reports the first state.
    document.addEventListener("visibilitychange", onVis);
    return () => {
      io?.disconnect();
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [count]);

  // Touch swipe — capture the start X, track the delta, commit past a ~40px threshold.
  // `touch-pan-y` on the stage keeps vertical page scroll working.
  const touchStartXRef = useRef<number | null>(null);
  const touchDeltaXRef = useRef(0);
  const handleTouchStart = (e: React.TouchEvent<HTMLDivElement>) => {
    touchStartXRef.current = e.touches[0]?.clientX ?? null;
    touchDeltaXRef.current = 0;
  };
  const handleTouchMove = (e: React.TouchEvent<HTMLDivElement>) => {
    if (touchStartXRef.current === null) return;
    const x = e.touches[0]?.clientX;
    if (x !== undefined) touchDeltaXRef.current = x - touchStartXRef.current;
  };
  const handleTouchEnd = () => {
    const delta = touchDeltaXRef.current;
    touchStartXRef.current = null;
    touchDeltaXRef.current = 0;
    if (Math.abs(delta) <= 40 || count <= 1) return;
    if (delta < 0) step(1);
    else step(-1);
  };

  // Clamp during render (no effect): if the slide list shrank, fall back to the first.
  const index = current < count ? current : 0;
  const slide = slides[index];

  // GA4 view_promotion when a slide becomes active, deduped per slide per mount
  // (so autoplay looping back doesn't re-fire). Gated by the « promotion » event
  // group (default OFF) — emits nothing until the owner enables it in Suivi &
  // Analytics. The hero is the store's main on-site campaign surface.
  const seenPromoRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const s = slides[index];
    if (!s) return;
    const key = s.title || `slide_${index}`;
    if (seenPromoRef.current.has(key)) return;
    seenPromoRef.current.add(key);
    track("view_promotion", {
      meta: { promotion_id: key, promotion_name: s.title ?? "", creative_slot: "home_hero" },
    });
  }, [index, slides]);

  if (!slide) return null;
  // GA4 select_promotion on any CTA / whole-slide click (same « promotion » gate).
  const fireSelect = () =>
    track("select_promotion", {
      meta: {
        promotion_id: slide.title || `slide_${index}`,
        promotion_name: slide.title ?? "",
        creative_slot: "home_hero",
      },
    });
  const hold = hovered || focused || offscreen;
  const controlProps = { slides, index, stopped, onSelect: select, onToggle: toggle };

  const onKeyDown = (e: React.KeyboardEvent<HTMLElement>) => {
    if (count <= 1) return;
    // Arrow keys never move the slide out from under a focused CTA (the copy re-keys).
    if ((e.target as HTMLElement).closest("a")) return;
    if (e.key === "ArrowRight") {
      e.preventDefault();
      step(1);
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      step(-1);
    }
  };

  return (
    // No bottom margin: the first section below owns the hero→content gap through its
    // own top padding, so the page runs on one vertical rhythm.
    <section
      ref={sectionRef}
      aria-roledescription="carrousel"
      aria-label="À la une"
      className="relative w-full overflow-hidden bg-[#1f1c1a]"
      onPointerEnter={(e) => {
        if (e.pointerType === "mouse") setHovered(true);
      }}
      onPointerLeave={(e) => {
        if (e.pointerType === "mouse") setHovered(false);
      }}
      onFocusCapture={() => setFocused(true)}
      onBlurCapture={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(false);
      }}
      onKeyDown={onKeyDown}
    >
      <div
        // Phones: fill the small viewport under the header — never taller than it, so the
        // bottom-anchored copy + slide controls always end ABOVE the fixed bottom bar (also
        // on short Safari viewports, ~553px svh); a 28rem floor only for truly tiny screens.
        // lg: end at the fold (viewport minus the header), within sane bounds.
        className="relative h-[86svh] min-h-[min(40rem,max(28rem,calc(100svh_-_5.5rem)))] w-full touch-pan-y select-none lg:h-[calc(100svh_-_6.5rem)] lg:min-h-[560px] lg:max-h-[1040px]"
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
      >
        {/* Background layers — a slow opacity crossfade; the incoming photograph settles
            from an almost imperceptible 2.5% drift (a transition, so leaving never snaps). */}
        {slides.map((s, i) => {
          // Base = the desktop crop, or the mobile crop when only it is set. Art-direct
          // (two layers) ONLY when both crops exist — next/image can't do it in one tag.
          const base = s.image ?? s.imageMobile;
          const mobile = s.image ? s.imageMobile : null;
          const alt = s.imageAlt ?? `${s.title} ${s.subtitle}`.trim();
          // A string poster for the <video> (next/image's ProductImage may be a
          // StaticImport; only a plain URL works as a poster attribute).
          const poster = typeof base === "string" ? base : (base?.src ?? undefined);
          return (
            <div
              key={i}
              aria-hidden={i !== index}
              className={cn(
                "absolute inset-0 transition-opacity duration-[1800ms] ease-in-out",
                i === index ? "opacity-100" : "opacity-0",
              )}
            >
              <div
                className={cn(
                  "absolute inset-0 transition-[scale] duration-[14000ms] ease-linear motion-reduce:transition-none motion-reduce:scale-100",
                  i === index ? "scale-100" : "scale-[1.025]",
                )}
              >
                {s.video ? (
                  // Ambient video: muted + looped + inline, the still image as poster so
                  // the first frame paints instantly. Only the ACTIVE slide's video plays
                  // (HeroVideo pauses + rewinds the rest), so N video slides never decode
                  // concurrently behind the crossfade. The image below is the reduced-motion
                  // / load-failure fallback; the video is hidden under reduced motion ONLY
                  // when there's a fallback image (else a video-only slide would go blank).
                  <>
                    <HeroVideo
                      src={s.video}
                      active={i === index}
                      poster={poster}
                      priority={i === 0}
                      className={cn("h-full w-full object-cover", base && "motion-reduce:hidden")}
                    />
                    {base && (
                      <Image
                        src={base}
                        alt={alt}
                        fill
                        priority={i === 0}
                        sizes="100vw"
                        quality={70}
                        className="hidden object-cover motion-reduce:block"
                      />
                    )}
                  </>
                ) : (
                  base && (
                    <>
                      <Image
                        src={base}
                        alt={alt}
                        fill
                        priority={i === 0}
                        sizes="100vw"
                        // Behind the scrims a slightly lower quality is imperceptible but
                        // trims the LCP image bytes.
                        quality={70}
                        className={cn("object-cover", mobile && "hidden sm:block")}
                      />
                      {mobile && (
                        // Both crops of the FIRST slide are `priority`: next/image's preload
                        // link is NOT media-scoped, so prioritising only the desktop crop would
                        // preload the wrong (hidden) image on phones and leave the real mobile
                        // LCP lazy. Prioritising both guarantees the correct crop is preloaded on
                        // every viewport; the cost is the first slide's other crop also preloads.
                        <Image src={mobile} alt={alt} fill priority={i === 0} sizes="100vw" quality={70} className="object-cover sm:hidden" />
                      )}
                    </>
                  )
                )}
              </div>
            </div>
          );
        })}

        {/* Legibility scrims. Phones: the copy sits low over a deep floor (light side wash).
            lg: the copy sits mid-left, so the left wash carries it and the floor relaxes. */}
        <div
          aria-hidden
          className="absolute inset-0 z-[1] bg-gradient-to-r from-black/30 to-transparent lg:from-black/60 lg:via-black/30"
        />
        <div
          aria-hidden
          className="absolute inset-0 z-[1] bg-gradient-to-t from-black/70 via-black/35 to-black/10 lg:from-black/45 lg:via-black/10 lg:to-transparent"
        />

        {/* Image/video-only slide (show_text = false): the whole stage is the link to the
            first button's target, when one is set. Sits above the scrims but below the
            carousel controls (z-[3]) so the dashes/pause stay clickable. */}
        {!slide.showText && slide.buttons[0]?.href && (
          <SmartLink href={slide.buttons[0].href} className="absolute inset-0 z-[2]" onClick={fireSelect}>
            <span className="sr-only">{slide.buttons[0].label || slide.title}</span>
          </SmartLink>
        )}

        {/* The autoplay timer — invisible, mounted once, never display:none (a hidden
            animation never ends). Its animationend advances; holds pause it in place. */}
        {count > 1 && !stopped && (
          <span
            key={`t-${index}`}
            aria-hidden
            className="tk-hero-timer pointer-events-none absolute left-0 top-0 h-px w-px opacity-0"
            style={{ animationDuration: `${AUTOPLAY_MS}ms`, animationPlayState: hold ? "paused" : "running" }}
            onAnimationEnd={advance}
          />
        )}
        {count > 1 && (
          <p className="sr-only" aria-live="polite" aria-atomic="true">
            {announce}
          </p>
        )}

        {/* Copy — in the SAME 1400 column as every section below. Re-keyed per slide so the
            entrance replays; anchored low on phones (clear of the fixed mobile bottom bar,
            which lives below lg), centred on desktop. */}
        {/* pb tracks the fixed mobile bottom bar (incl. its safe-area inset) below lg.
            pointer-events-none so this full-stage overlay never eats clicks meant for the
            `show_text=false` whole-slide link beneath it (same z-[2], earlier in the DOM); the
            real interactive children (the CTA row + the mobile controls) re-enable pointer events. */}
        <div className="pointer-events-none absolute inset-0 z-[2] flex items-end pb-[calc(4.75rem_+_max(0.75rem,env(safe-area-inset-bottom)))] lg:items-center lg:pb-10">
          <div className={cn(SECTION_CONTAINER, "w-full")}>
            <div
              key={index}
              className="tk-hero-copy max-w-[44rem]"
              style={navigated ? { animationDelay: "300ms" } : undefined}
            >
              {/* `show_text = false` → a pure image/video slide: the headline stays in the
                  DOM for SEO/a11y (the page keeps its <h1>) but is visually hidden, and no
                  eyebrow/description/buttons paint. The whole slide becomes the link below. */}
              {slide.showText ? (
                <>
                  {slide.eyebrow && (
                    <p className="mb-5 font-body [@media(max-height:44rem)]:mb-3 text-[0.66rem] uppercase tracking-[0.26em] text-white/90">{slide.eyebrow}</p>
                  )}
                  {/* Always the page <h1> — one visible headline, whatever slide is showing. */}
                  <h1 className="text-balance font-serif text-[2.4rem] font-normal leading-[1.08] text-white sm:text-[3.25rem] lg:text-[3.9rem] xl:text-[4.4rem]">
                    {keepCompounds(slide.title)}
                    {slide.subtitle && <span className={cn("block italic", ON_PHOTO_ACCENT)}>{keepCompounds(slide.subtitle)}</span>}
                  </h1>
                  {slide.description && (
                    <p className="mt-6 max-w-md font-body [@media(max-height:44rem)]:mt-4 text-sm leading-[1.75] text-white/85 sm:text-base">
                      {slide.description}
                    </p>
                  )}
                  {slide.buttons.length > 0 && (
                    <div className="pointer-events-auto mt-8 flex flex-wrap items-center gap-x-8 gap-y-4 [@media(max-height:44rem)]:mt-6">
                      {/* SmartLink (same as every other home block): an external banner CTA
                          (https://…) opens with target/rel; internal links use next/link.
                          Each button uses its operator-chosen design (BANNER_BUTTON_STYLE →
                          the shared button system); a `link`-design button is the quiet
                          on-photo underline. */}
                      {slide.buttons.map((b, bi) =>
                        isLinkDesign(b.variant) ? (
                          <SmartLink key={bi} href={b.href} className={ON_PHOTO_LINK} onClick={fireSelect}>
                            <span className={ON_PHOTO_LINK_LABEL}>{b.label}</span>
                          </SmartLink>
                        ) : (
                          <SmartLink
                            key={bi}
                            href={b.href}
                            className={buttonVariants({ ...BANNER_BUTTON_STYLE[b.variant], size: "md" })}
                            onClick={fireSelect}
                          >
                            <span className="btn__label">{b.label}</span>
                          </SmartLink>
                        ),
                      )}
                    </div>
                  )}
                </>
              ) : (
                <h1 className="sr-only">{`${slide.title} ${slide.subtitle}`.trim()}</h1>
              )}
            </div>
            {/* Below lg the controls flow under the copy (the fixed mobile bottom bar would
                cover a bottom-anchored set) — a sibling of the keyed copy, so they never
                re-animate or drop focus on a slide change. */}
            {count > 1 && (
              <div className="pointer-events-auto -ml-2 mt-6 lg:hidden [@media(max-height:44rem)]:mt-4">
                <HeroControls {...controlProps} />
              </div>
            )}
          </div>
        </div>

        {/* lg+: the same quiet controls, bottom-right. Only one set displays per breakpoint. */}
        {count > 1 && (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 z-[3] hidden pb-10 lg:block">
            <div className={cn(SECTION_CONTAINER, "flex justify-end")}>
              <div className="pointer-events-auto">
                <HeroControls {...controlProps} />
              </div>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

/**
 * A single slide's ambient background video. Plays ONLY while its slide is active —
 * when inactive it pauses and rewinds to the first frame, so several video slides never
 * decode/play at once behind the crossfade (and a returning slide restarts clean). Muted
 * + inline is the only autoplay browsers allow without a gesture; a play() rejection
 * (autoplay blocked) is swallowed and the poster/fallback image stands in.
 */
function HeroVideo({
  src,
  active,
  poster,
  priority,
  className,
}: {
  src: string;
  active: boolean;
  poster?: string;
  priority: boolean;
  className?: string;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (active) {
      void el.play().catch(() => {});
    } else {
      el.pause();
      // Rewind so the slide restarts from the top next time it's shown.
      try {
        el.currentTime = 0;
      } catch {
        /* some browsers throw before metadata loads — harmless */
      }
    }
  }, [active]);
  return (
    <video
      ref={ref}
      className={className}
      autoPlay={active}
      muted
      loop
      playsInline
      preload={priority ? "auto" : "metadata"}
      poster={poster}
      aria-hidden
    >
      <source src={src} />
    </video>
  );
}

type HeroControlsProps = {
  slides: HomeHeroSlide[];
  index: number;
  stopped: boolean;
  onSelect: (i: number) => void;
  onToggle: () => void;
};

/** Ivory hairline dashes (the active one longer) + a small pause / play glyph. */
function HeroControls({ slides, index, stopped, onSelect, onToggle }: HeroControlsProps) {
  const count = slides.length;
  return (
    <div className="flex items-center">
      <div role="group" aria-label="Choisir une diapositive" className="flex items-center">
        {slides.map((s, i) => {
          const active = i === index;
          const label = s.eyebrow || s.title;
          return (
            <button
              key={i}
              type="button"
              onClick={() => onSelect(i)}
              aria-current={active ? "true" : undefined}
              aria-label={`Diapositive ${i + 1} sur ${count}${label ? ` : ${label}` : ""}`}
              className="group/dash grid h-11 place-items-center rounded-sm px-2 lg:h-8 lg:px-1.5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
            >
              <span
                aria-hidden
                className={cn(
                  "block h-[1.5px] transition-[width,background-color] duration-700 motion-reduce:transition-none",
                  EASE,
                  active ? "w-9 bg-white" : "w-4 bg-white/60 group-hover/dash:bg-white/90",
                )}
              />
            </button>
          );
        })}
      </div>
      {/* Nothing auto-advances under reduced motion, so the pause control isn't needed there. */}
      <span aria-hidden className="mx-3 h-3 w-px bg-white/30 motion-reduce:hidden" />
      <button
        type="button"
        onClick={onToggle}
        aria-label={stopped ? "Reprendre le défilement" : "Mettre le défilement en pause"}
        className="grid h-11 w-11 place-items-center rounded-full lg:h-8 lg:w-8 text-white/75 transition-colors duration-500 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white motion-reduce:hidden"
      >
        {stopped ? (
          <Play className="h-3.5 w-3.5" strokeWidth={1.5} aria-hidden />
        ) : (
          <Pause className="h-3.5 w-3.5" strokeWidth={1.5} aria-hidden />
        )}
      </button>
    </div>
  );
}
