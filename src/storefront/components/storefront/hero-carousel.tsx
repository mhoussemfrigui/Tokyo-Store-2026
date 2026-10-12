"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import useEmblaCarousel from "embla-carousel-react";
import { Pause, Play } from "lucide-react";

import { RailArrow } from "@/storefront/components/storefront/rail-arrow";
import { btn } from "@/storefront/components/storefront/ui-classes";
import { prefersReducedMotion } from "@/storefront/lib/motion";
import { cn } from "@/storefront/lib/utils";

/** One CTA rendered over a slide (overlay mode). */
export type HeroButton = { label: string; href: string; variant?: string };

/**
 * One hero slide. Backend-driven (CMS → Page d'accueil, via the médiathèque) with
 * the built-in artwork as a pixel-identical fallback. The default artwork is
 * 1920x720 (8:3) with the copy baked in, so those slides render as full-bleed
 * image links with NO overlay — `--banner-h` is derived from that ratio.
 */
export type Slide = {
  /** Stable key (two slides may share an image / an operator may reuse artwork). */
  id: string;
  image: string;
  /** Describes the baked-in copy (or the overlay title) for screen readers. */
  alt: string;
  /** Full-image link target, used when `showText` is false (the default look). */
  href: string;
  /** Art-directed MOBILE image (médiathèque). When set it replaces the desktop
   *  crop below sm; when null the desktop image is cropped via `mobilePos`. */
  imageMobile?: string | null;
  /**
   * Which side of the artwork to keep on phones when there is no mobile image.
   * --banner-h floors at 220px while the artwork is 8:3, so below ~610px the box
   * is taller than the ratio and `cover` crops the sides: anchor on the copy's side.
   */
  mobilePos?: "object-left" | "object-right";
  /** true → render the eyebrow/title/subtitle/buttons overlay instead of a pure
   *  image link (keeps the Bannières overlay feature); false (default) = image link. */
  showText?: boolean;
  eyebrow?: string | null;
  title?: string | null;
  subtitle?: string | null;
  buttons?: HeroButton[];
};

/** Built-in slides — shown when the operator has configured none (pixel-identical
 *  to the launch artwork). Edited/added slides come from the backend and override
 *  these wholesale. */
const FALLBACK_SLIDES: Slide[] = [
  {
    id: "fallback-1",
    image: "/assets/1.webp",
    alt: "Série 18 et Duo en précommande — certifié et garanti",
    href: "/iphones-neufs",
    mobilePos: "object-left",
  },
  {
    id: "fallback-2",
    image: "/assets/2.webp",
    alt: "Z Fold 8 — précommandez dès maintenant",
    href: "/smartphones",
    /* The only banner with its copy on the right. */
    mobilePos: "object-right",
  },
  {
    id: "fallback-3",
    image: "/assets/3.webp",
    alt: "iPhones neufs — certifiés et garantis",
    href: "/iphones-neufs",
    mobilePos: "object-left",
  },
  {
    id: "fallback-4",
    image: "/assets/4.webp",
    alt: "iPhones d'occasion — batterie +90% et garantie",
    href: "/iphones-d-occasion",
    mobilePos: "object-left",
  },
];

const AUTOPLAY_MS = 6000;

function subscribeReducedMotion(onChange: () => void) {
  const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}

/** The slide image. When the slide carries a separate mobile image it swaps in
 *  below sm via <picture>; otherwise the desktop image is cropped to the copy's
 *  side (mobilePos) — the built-in artwork's behaviour. All slides load eager:
 *  a lazy slide inside the clipped/transformed track stayed unrequested and
 *  rendered as an empty banner. */
function HeroSlideImage({
  slide,
  eager,
  decorative,
}: {
  slide: Slide;
  eager: boolean;
  decorative: boolean;
}) {
  const imgClass = cn(
    "h-[var(--banner-h)] w-full object-cover sm:object-center",
    !slide.imageMobile && slide.mobilePos,
  );
  const alt = decorative ? "" : slide.alt;
  const img = (
    <img
      src={slide.image}
      alt={alt}
      width={1920}
      height={720}
      loading="eager"
      decoding="async"
      fetchPriority={eager ? "high" : "low"}
      className={imgClass}
    />
  );
  if (!slide.imageMobile) return img;
  return (
    <picture>
      <source media="(max-width: 639px)" srcSet={slide.imageMobile} />
      {img}
    </picture>
  );
}

const OVERLAY_BTN: Record<string, string> = {
  primary: btn.primary,
  secondary: "bg-background/90 text-foreground hover:bg-background",
  onyx: "bg-foreground text-background hover:brightness-110",
  ghost: "border border-background/40 text-background hover:bg-background/10",
  link: "underline underline-offset-4 text-background",
  "on-photo": "bg-background/90 text-foreground hover:bg-background",
};

/** Optional text/button overlay (slide.showText) — keeps the Bannières overlay
 *  feature for operators who want copy rendered over the image instead of baked
 *  into it. The image is decorative here (the overlay carries the meaning). */
function HeroSlideOverlay({ slide, eager }: { slide: Slide; eager: boolean }) {
  return (
    <div className="relative">
      <HeroSlideImage slide={slide} eager={eager} decorative />
      <div className="absolute inset-0 z-[1] flex flex-col items-start justify-end gap-2.5 bg-gradient-to-t from-black/55 via-black/10 to-transparent p-5 text-background sm:gap-3 sm:p-10 lg:p-12">
        {slide.eyebrow && (
          <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-background/85 sm:text-xs">
            {slide.eyebrow}
          </p>
        )}
        {slide.title && (
          <h2 className="max-w-[22ch] text-2xl font-black leading-[1.05] tracking-[-0.02em] text-balance sm:text-4xl lg:text-5xl">
            {slide.title}
          </h2>
        )}
        {slide.subtitle && (
          <p className="max-w-[40ch] text-sm leading-relaxed text-background/85 sm:text-base">
            {slide.subtitle}
          </p>
        )}
        {slide.buttons && slide.buttons.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-2.5">
            {slide.buttons.map((b, i) => (
              <Link
                key={`${b.href}-${i}`}
                href={b.href}
                className={cn(btn.base, btn.md, OVERLAY_BTN[b.variant ?? "primary"] ?? btn.primary)}
              >
                {b.label}
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export function HeroCarousel({ slides = FALLBACK_SLIDES }: { slides?: Slide[] } = {}) {
  /* Empty backend set → the built-in artwork, so the hero is never blank. */
  if (slides.length === 0) slides = FALLBACK_SLIDES;
  /* Server snapshot `false`: the markup is the same either way, only the
     timer and the slide transition depend on it. */
  const reduce = useSyncExternalStore(subscribeReducedMotion, prefersReducedMotion, () => false);
  const [emblaRef, emblaApi] = useEmblaCarousel({ loop: true, duration: reduce ? 0 : 25 });
  const [selected, setSelected] = useState(0);

  /* Autoplay (WCAG 2.2.2): off by default under reduced motion, and the
     toggle lets anyone stop it — or opt back in. `null` = no choice made yet. */
  const [stopped, setStopped] = useState<boolean | null>(null);
  const playing = stopped === null ? !reduce : !stopped;
  /* Hover or keyboard focus inside the banner holds the current slide. */
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const toggleRef = useRef<HTMLButtonElement>(null);

  const scrollPrev = useCallback(() => emblaApi?.scrollPrev(), [emblaApi]);
  const scrollNext = useCallback(() => emblaApi?.scrollNext(), [emblaApi]);

  useEffect(() => {
    if (!emblaApi) return;
    const onSelect = () => setSelected(emblaApi.selectedScrollSnap());
    emblaApi.on("select", onSelect);
    onSelect();
    return () => {
      emblaApi.off("select", onSelect);
    };
  }, [emblaApi]);

  /* One timeout per slide rather than a free-running interval, so a slide the
     visitor just swiped to or picked always gets its full six seconds. */
  useEffect(() => {
    if (!emblaApi || !playing || hovered || focused) return;
    const t = setTimeout(() => emblaApi.scrollNext(), AUTOPLAY_MS);
    return () => clearTimeout(t);
  }, [emblaApi, playing, hovered, focused, selected]);

  return (
    /* From lg up the banner is pulled under the nav band (minus a 12px top
       margin) so the floating pill sits an even 12px inside the artwork on the
       top and both sides. Below lg it is NOT pulled up and starts 12px below
       the nav: the copy is baked into the artwork, so unlike PageTop's HTML
       text it cannot pad itself clear of the pill, and until the banner is
       ~330px tall (≈920px wide) the pill's bottom 76px hid the top of
       "IPHONES" (slide 3) and touched the slide 4 headline. From 1024 every
       headline clears the pill. See --nav-h / --banner-h in globals.css. */
    <section
      aria-roledescription="carousel"
      aria-label="Bannières"
      className="envelope-x relative mt-3 lg:-mt-[calc(var(--nav-h)-0.75rem)]"
      /* Mouse only: a tap fires a compat mouseenter with no matching leave,
         which would freeze the carousel on touch screens. */
      onPointerEnter={(e) => e.pointerType === "mouse" && setHovered(true)}
      onPointerLeave={(e) => e.pointerType === "mouse" && setHovered(false)}
      /* Keyboard focus holds the slide (a mouse click already counts as a
         hover); focus on the toggle itself doesn't, or pressing "Reprendre"
         would appear to do nothing. */
      onFocus={(e) =>
        setFocused(e.target !== toggleRef.current && e.target.matches(":focus-visible"))
      }
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(false);
      }}
    >
      {/* Hairline border + soft lift so light artwork doesn't merge into the
          off-white page background. 44px from md = the pill's 32 + its 12px
          inset, so the two curves are concentric wherever the pill sits
          inside. The slide link is clipped by this box, so its focus ring is
          drawn here instead. */}
      <div className="radius-envelope relative overflow-hidden border border-border bg-surface-warm shadow-card has-[a:focus-visible]:outline-2 has-[a:focus-visible]:outline-offset-2 has-[a:focus-visible]:outline-ring">
        <div className="overflow-hidden" ref={emblaRef}>
          <div className="flex touch-pan-y">
            {slides.map((slide, i) => (
              <div
                key={slide.id}
                role="group"
                aria-roledescription="slide"
                aria-label={`${i + 1} sur ${slides.length}`}
                /* Off-screen slides leave the tab order and the a11y tree. */
                inert={i !== selected}
                className="min-w-0 flex-[0_0_100%]"
              >
                {slide.showText ? (
                  <HeroSlideOverlay slide={slide} eager={i === 0} />
                ) : (
                  <Link href={slide.href} className="block">
                    <HeroSlideImage slide={slide} eager={i === 0} decorative={false} />
                  </Link>
                )}
              </div>
            ))}
          </div>
        </div>

        {/* Controls: one row along the banner's bottom edge. Every artwork
            carries its copy in a band across the middle and its product
            imagery in the bottom corners, so the controls live there.

            Dots, in a small capsule so they stay visible on any banner. It
            sits in whichever corner is free of the baked-in copy: on phones
            the crop keeps the copy's side at full height, and the bottom band
            carries "+Certifié / +Garantie" on three of the four banners, so it
            goes top-right (the pill is not over the banner there); from sm the
            whole artwork shows and the bottom-right corner is product imagery
            on all four. It stays there, beside the next arrow, up to xl —
            centred at 1024 it sat on "+Garantie" — and is centred from xl, as
            in the reference. Below lg it is 30px tall with a 2px inset, so the
            round toggle is concentric with it (15 − 1 − 2 = 12), and 12px into
            the phone banner's 28px corner (28 − 12 ≈ 15). The buttons touch
            (no gap): their own 9px sides make the marks an even 18px apart,
            close to the reference's 16, instead of spreading the capsule out.
            The end insets balance the toggle icon's own 5px margin against
            the last dot's 9px. Below 360px (the 184px --banner-h) the
            capsule rises to 8px from the top: at 12 its bottom edge sat
            flush on slide 3's "IPHONES".

            Arrows — light glass so they read on both light and dark artwork —
            from lg only (phones and tablets swipe or use the dots), in the
            bottom corners: centred on the height they sat on the headline
            ("Série 18", "Z Fold 8") at every desktop width. */}
        <div className="absolute right-3 top-3 z-10 flex max-[22.5rem]:top-2 items-center gap-2 sm:bottom-4 sm:right-4 sm:top-auto md:bottom-5 md:right-5 lg:left-5">
          <RailArrow
            direction="prev"
            label="Précédent"
            onClick={scrollPrev}
            className="mr-auto hidden lg:grid"
          />
          <div className="flex items-center rounded-full border border-border bg-background/80 py-0.5 pl-0.5 backdrop-blur-md lg:py-2 lg:pl-3 lg:pr-2 xl:mr-auto">
            <button
              ref={toggleRef}
              type="button"
              onClick={() => setStopped(playing)}
              aria-label={playing ? "Mettre en pause le défilement" : "Reprendre le défilement"}
              className="grid size-6 place-items-center rounded-full text-foreground transition-colors duration-200 hover:bg-secondary"
            >
              {playing ? (
                <Pause aria-hidden className="size-3.5" />
              ) : (
                <Play aria-hidden className="size-3.5" />
              )}
            </button>
            {slides.map((slide, i) => (
              <button
                key={slide.id}
                type="button"
                aria-label={`Bannière ${i + 1}`}
                aria-current={i === selected ? "true" : undefined}
                onClick={() => emblaApi?.scrollTo(i)}
                /* 24×24 minimum target (WCAG 2.5.8): 6px mark + 2 × 9px. The
                   bar inside is the visual. */
                className="group/dot grid h-6 place-items-center px-[9px]"
              >
                <span
                  className={cn(
                    "block h-1.5 rounded-full transition-all duration-300",
                    i === selected
                      ? "w-7 bg-primary"
                      : "w-1.5 bg-foreground/25 group-hover/dot:bg-foreground/50",
                  )}
                />
              </button>
            ))}
          </div>
          <RailArrow
            direction="next"
            label="Suivant"
            onClick={scrollNext}
            className="hidden lg:grid"
          />
        </div>
      </div>
    </section>
  );
}
