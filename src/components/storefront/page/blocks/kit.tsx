import Link from "next/link";

import { cn } from "@/lib/utils";
import { buttonVariants, type ButtonVariant } from "@/components/ui/button";
import { SECTION_CONTAINER } from "@/lib/pages/block-model";
import { realHref, type BlockImage, type BlockPresentation, type ImageFit } from "@/lib/pages/page-blocks";
import { safeHref } from "@/lib/utils/safe-href";
import type { ResolvedMedia } from "@/modules/media";

/**
 * Shared layout kit for the block renderers — the CMS content pages
 * (page-blocks-render.tsx) AND the composed homepage (home/home-blocks-render.tsx), so
 * the two surfaces speak one design language.
 *
 * Harmony contract (2026-10-01 redesign): every page block sits in the SAME canonical
 * container as the header, listing pages and footer (SECTION_CONTAINER = 1400px +
 * 20/32/48px gutters) and composes on a 12-column grid — headings in a 4/12 column,
 * prose in a 7/12 reading column, grids across all 12. Nothing narrows to a centred
 * 736/1024px island any more (that is what made the old pages look "horizontally small").
 * Sections are separated by TONE (tk-tone-* in globals.css), never by hairlines.
 */

// ── Tones / rhythm ─────────────────────────────────────────────────────────────
const TONE: Record<BlockPresentation["background"], string> = {
  default: "",
  surface: "tk-tone-surface",
  muted: "tk-tone-muted",
  dark: "tk-tone-dark",
  olive: "tk-tone-olive",
};
export const toneClass = (bg?: BlockPresentation["background"]) => TONE[bg ?? "default"] ?? "";

const PAD = {
  default: "py-16 sm:py-20 lg:py-24",
  tight: "py-10 sm:py-12",
  spacious: "py-20 sm:py-28 lg:py-32",
  none: "py-0",
  hero: "pt-12 pb-14 sm:pt-16 sm:pb-20 lg:pt-20 lg:pb-24",
} as const;

/** The vertical rhythm for a section — the block's own padding, or an explicit override
 *  ("hero"). Exported for wrappers that supply their OWN horizontal frame. (The home no
 *  longer uses it — it has its own HomeSection rhythm, see home-blocks-render.tsx.) */
export function sectionPad(presentation?: BlockPresentation, pad?: keyof typeof PAD): string {
  const p = presentation;
  return PAD[pad ?? (p?.padding && p.padding !== "default" ? p.padding : "default")];
}

/** A full-bleed page section: tone edge-to-edge, content in the canonical container. */
export function PageSection({
  presentation,
  anchor,
  pad,
  className,
  innerClassName,
  children,
}: {
  presentation?: BlockPresentation;
  anchor?: string;
  /** Override the rhythm (hero openers use "hero"); otherwise the block's padding. */
  pad?: keyof typeof PAD;
  className?: string;
  innerClassName?: string;
  children: React.ReactNode;
}) {
  const p = presentation;
  return (
    <section
      id={anchor || undefined}
      className={cn("w-full scroll-mt-28", toneClass(p?.background), p?.divider && "border-t border-border/60", className)}
    >
      <div className={cn(p?.width === "full" ? "mx-auto w-full max-w-none" : SECTION_CONTAINER, sectionPad(p, pad), innerClassName)}>
        {children}
      </div>
    </section>
  );
}

// ── Typography ─────────────────────────────────────────────────────────────────
/** `data-eyebrow` is a zero-visual styling hook: the home scopes a quieter eyebrow to it
 *  (globals.css `.tk-home [data-eyebrow]`) while the content pages stay pixel-identical. */
export function Eyebrow({ children, className }: { children: React.ReactNode; className?: string }) {
  if (!children) return null;
  return (
    <p data-eyebrow className={cn("mb-4 flex items-center gap-3 font-body text-[0.65rem] uppercase tracking-[0.3em] text-olive", className)}>
      <span aria-hidden className="h-px w-8 shrink-0 bg-gold/60" />
      <span>{children}</span>
    </p>
  );
}

/** Title with an optional italic ACCENT on its own line (« Chaque seconde » / « est un
 *  souvenir. ») — the maison's signature two-tone heading. `accentStyle` picks the accent
 *  colour: « gold » (signature, default) or « ink » (a quiet second line in the title ink). */
export function Title({
  as: Tag = "h2",
  text,
  accent,
  accentStyle = "gold",
  className,
}: {
  as?: "h1" | "h2" | "h3";
  text?: string;
  accent?: string;
  accentStyle?: "gold" | "ink";
  className?: string;
}) {
  if (!text && !accent) return null;
  return (
    <Tag className={cn("font-serif font-normal tracking-tight text-balance text-foreground", className)}>
      {text}
      {accent && <span className={cn("block italic", accentStyle === "ink" ? "text-foreground" : "text-gold")}>{accent}</span>}
    </Tag>
  );
}

export const H_SECTION = "text-3xl leading-[1.08] md:text-4xl lg:text-[2.75rem]";
export const H_DISPLAY = "text-[2.6rem] leading-[1.02] sm:text-6xl lg:text-7xl";
export const H_PAGE = "text-4xl leading-[1.05] sm:text-5xl lg:text-6xl";
export const BODY = "font-body text-sm leading-relaxed text-muted-foreground sm:text-base";

/** Section head on the 12-col grid: title left (7/12), subtitle/aside bottom-right (4/12)
 *  — or a centred stack when the block asks for `align: center`. */
export function HeadRow({
  eyebrow,
  title,
  accent,
  accentStyle,
  subtitle,
  align = "left",
  chapter,
  aside,
  splitAt = "lg",
}: {
  eyebrow?: string;
  title?: string;
  accent?: string;
  accentStyle?: "gold" | "ink";
  subtitle?: string;
  align?: BlockPresentation["align"];
  chapter?: string;
  aside?: React.ReactNode;
  /** OPT-IN: where the title/aside split into two columns. Default "lg" (the Pages,
   *  unchanged); the home passes "md" so tablets don't stack a lone aside row. */
  splitAt?: "md" | "lg";
}) {
  if (!eyebrow && !title && !accent && !subtitle && !aside && !chapter) return null;
  if (align === "center") {
    return (
      <div className="tk-fade-in-up mx-auto mb-10 max-w-3xl text-center sm:mb-14">
        {chapter && <p className="mb-3 font-serif text-4xl leading-none text-gold">{chapter}</p>}
        {eyebrow && <Eyebrow className="justify-center">{eyebrow}</Eyebrow>}
        <Title text={title} accent={accent} accentStyle={accentStyle} className={H_SECTION} />
        {subtitle && <p className={cn(BODY, "mx-auto mt-5 max-w-2xl")}>{subtitle}</p>}
        {aside && <div className="mt-6 flex justify-center">{aside}</div>}
      </div>
    );
  }
  const md = splitAt === "md";
  return (
    <div
      className={
        md
          ? "tk-fade-in-up mb-10 grid gap-y-5 sm:mb-14 md:grid-cols-12 md:items-end md:gap-x-8 lg:gap-x-10"
          : "tk-fade-in-up mb-10 grid gap-y-5 sm:mb-14 lg:grid-cols-12 lg:items-end lg:gap-x-10"
      }
    >
      <div className={md ? "md:col-span-7" : "lg:col-span-7"}>
        {chapter && <p className="mb-3 font-serif text-4xl leading-none text-gold">{chapter}</p>}
        {eyebrow && <Eyebrow>{eyebrow}</Eyebrow>}
        <Title text={title} accent={accent} accentStyle={accentStyle} className={H_SECTION} />
      </div>
      {(subtitle || aside) && (
        <div className={md ? "md:col-span-5 md:col-start-8 md:pb-1 lg:col-span-4 lg:col-start-9" : "lg:col-span-4 lg:col-start-9 lg:pb-1"}>
          {subtitle && <p className={BODY}>{subtitle}</p>}
          {aside && <div className={subtitle ? "mt-5" : ""}>{aside}</div>}
        </div>
      )}
    </div>
  );
}

// ── Grids ──────────────────────────────────────────────────────────────────────
/** Column classes chosen by ITEM COUNT so a grid never leaves an orphan card
 *  (5 steps → 5 columns, 3 cards → 3, 6 → 3×2, 8 → 4×2). Static strings for Tailwind. */
export function colsFor(n: number, max = 5): string {
  if (n <= 1) return "grid-cols-1";
  if (n === 2) return "grid-cols-1 sm:grid-cols-2";
  if (n === 3) return "grid-cols-1 md:grid-cols-3";
  if (n === 4) return max >= 4 ? "grid-cols-1 sm:grid-cols-2 lg:grid-cols-4" : "grid-cols-1 sm:grid-cols-2";
  if (n === 5) return max >= 5 ? "grid-cols-1 sm:grid-cols-2 lg:grid-cols-5" : "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3";
  if (n === 6) return "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3";
  return max >= 4 ? "grid-cols-1 sm:grid-cols-2 lg:grid-cols-4" : "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3";
}

// ── Links / CTAs ───────────────────────────────────────────────────────────────
const isExternal = (href: string) => /^(https?:)?\/\//i.test(href) || href.startsWith("mailto:") || href.startsWith("tel:");

/** A real link or nothing — never a dead `href="#"`. External targets open safely. */
export function SmartLink({
  href,
  className,
  children,
  ...rest
}: { href: string; className?: string; children: React.ReactNode } & Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, "href">) {
  const h = realHref(safeHref(href));
  if (!h) return <span className={className}>{children}</span>;
  if (/^https?:\/\//i.test(h)) {
    return (
      <a href={h} className={className} target="_blank" rel="noopener noreferrer" {...rest}>
        {children}
      </a>
    );
  }
  if (isExternal(h)) {
    return (
      <a href={h} className={className} {...rest}>
        {children}
      </a>
    );
  }
  return (
    <Link href={h} className={className} {...rest}>
      {children}
    </Link>
  );
}

/** Primary + secondary CTA pair on the standard button system (only real links render). */
export function CtaPair({
  primary,
  secondary,
  className,
  size = "md",
  primaryVariant = "primary",
}: {
  primary?: { label?: string; href?: string };
  secondary?: { label?: string; href?: string };
  className?: string;
  size?: "sm" | "md" | "lg";
  primaryVariant?: ButtonVariant;
}) {
  const p = primary?.label && realHref(primary.href) ? primary : null;
  const s = secondary?.label && realHref(secondary.href) ? secondary : null;
  if (!p && !s) return null;
  return (
    <div className={cn("flex flex-wrap items-center gap-3", className)}>
      {p && (
        <SmartLink href={p.href!} className={buttonVariants({ variant: primaryVariant, size })}>
          <span className="btn__label">{p.label}</span>
        </SmartLink>
      )}
      {s && (
        <SmartLink href={s.href!} className={buttonVariants({ variant: "secondary", size })}>
          <span className="btn__label">{s.label}</span>
        </SmartLink>
      )}
    </div>
  );
}

// ── Media ──────────────────────────────────────────────────────────────────────
export type PickedImage = { src: string; alt: string; width: number | null; height: number | null };

/** Resolve a block image slot through the batched médiathèque map. */
export function pickImage(
  media: Map<string, ResolvedMedia>,
  im: BlockImage | null | undefined,
  fallbackAlt = "",
): PickedImage | null {
  const m = im?.mediaId ? media.get(im.mediaId) : undefined;
  if (!m?.url) return null;
  return { src: m.url, alt: im?.alt || m.alt || fallbackAlt, width: m.width ?? null, height: m.height ?? null };
}

/** A product packshot (≈square or a background-removed cut-out) must be CONTAINED on a
 *  panel; a lifestyle photo can be cropped with object-cover. */
export function isPackshot(img: PickedImage): boolean {
  if (/-nobg/i.test(img.src)) return true;
  if (img.width && img.height) return Math.abs(img.width / img.height - 1) < 0.15;
  return false;
}
export const isPortrait = (img: PickedImage | null) =>
  Boolean(img?.width && img?.height && img.height > img.width * 1.05);

/**
 * An art-directed image frame. `fit: auto` contains packshots on a lit « vitrine » panel
 * and covers photos; desktop/mobile sources swap through <picture>. The opener's image
 * loads eagerly (it is the LCP), every other frame lazily.
 */
export function MediaFrame({
  image,
  mobile,
  fit = "auto",
  aspect,
  className,
  priority = false,
  rounded = "rounded-[1.75rem]",
}: {
  image: PickedImage;
  mobile?: PickedImage | null;
  fit?: ImageFit;
  aspect: string;
  className?: string;
  priority?: boolean;
  rounded?: string;
}) {
  const contain = fit === "contain" || (fit === "auto" && isPackshot(image));
  const loading = priority ? "eager" : "lazy";
  const fetchPriority = priority ? "high" : undefined;
  if (contain) {
    return (
      <div className={cn("tk-vitrine relative grid place-items-center overflow-hidden", rounded, aspect, className)}>
        <picture className="contents">
          {mobile && <source media="(max-width: 639px)" srcSet={mobile.src} />}
          <img
            src={image.src}
            alt={image.alt}
            loading={loading}
            fetchPriority={fetchPriority}
            decoding="async"
            className="h-[78%] w-auto max-w-[82%] object-contain drop-shadow-[0_28px_32px_rgba(43,40,37,0.16)]"
          />
        </picture>
      </div>
    );
  }
  return (
    <div className={cn("img-luxury relative overflow-hidden bg-muted", rounded, aspect, className)}>
      <picture>
        {mobile && <source media="(max-width: 639px)" srcSet={mobile.src} />}
        <img
          src={image.src}
          alt={image.alt}
          loading={loading}
          fetchPriority={fetchPriority}
          decoding="async"
          className="absolute inset-0 h-full w-full object-cover"
        />
      </picture>
    </div>
  );
}

/** Two-digit index (« 01 »). */
export const nn = (i: number) => String(i + 1).padStart(2, "0");
