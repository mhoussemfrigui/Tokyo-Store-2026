import { Fragment } from "react";
import Link from "next/link";
import { ArrowRight, ArrowUpRight } from "lucide-react";

import { cn } from "@/lib/utils";
import { buttonVariants } from "@/components/ui/button";
import { ProductGrid } from "@/components/storefront/product-grid";
import { ProductFaqAccordion } from "@/components/product-faq";
import { valuePropIcon } from "@/lib/catalog/value-prop-icons";
import { safeHref } from "@/lib/utils/safe-href";
import { realHref } from "@/lib/pages/page-blocks";
import {
  EMPTY_HEADER,
  SECTION_CONTAINER,
  heading,
  planSeams,
  sourceListingHref,
  type BlockHeader,
  type BlockPresentation,
  type HomeBlock,
  type HomeBlockType,
} from "@/lib/pages/home-blocks";
import type { ResolvedHome } from "@/lib/pages/home-blocks-data";
import {
  BODY,
  CtaPair,
  Eyebrow,
  H_SECTION,
  HeadRow,
  MediaFrame,
  SmartLink,
  Title,
  colsFor,
  isPackshot,
  isPortrait,
  nn,
  pickImage,
  type PickedImage,
} from "@/components/storefront/page/blocks/kit";
import { HomeHero, type HomeHeroSlide } from "./home-hero";
import { HomeRail } from "./home-rail";
import {
  CARD_CTA,
  CARD_LABEL,
  CARD_META,
  EASE,
  GRID_GAP_CARDS,
  GRID_GAP_TILES,
  ON_PHOTO_ACCENT,
  PANEL,
  QUIET_LINK,
  QUIET_LINK_ARROW,
  QUIET_LINK_LABEL,
} from "./home-style";
import type { ProductImage } from "@/types/catalog";

/**
 * Storefront renderer for the HOME block composer (a SERVER component).
 *
 * Design contract (2026-10): ONE page ground. Every section sits on the same Ivoire —
 * no tone bands (those are Pages-only); consecutive sections are separated by ONE very
 * soft hairline in the content column (`planSeams` decides: none under the hero carousel,
 * none beside a photo / framed banner, never above the footer). Per block the operator
 * edits « Séparation » (automatique / toujours un filet / enchaîner) and « Espacement »;
 * the home has its own symmetric rhythm (HomeSection — the kit's PageSection, shared with
 * the Pages, is untouched). Heads speak the Pages' language (kit HeadRow, two-tone title,
 * real-or-nothing links); dark moments are card-level only (the complication cards).
 * Quietly: one outline-pill button, one underlined link, one slow
 * cue per hover (tokens: home-style.ts). The shared ProductCard is NEVER restyled here.
 *
 * Every block keeps hide-when-unset, art-directed desktop/mobile images and the
 * médiathèque + safeHref seam; every visible string comes from the composer or the
 * catalogue (titles are seeded on add, never hard-coded at render).
 */

const EMPTY_H = EMPTY_HEADER;

type Ctx = {
  r: ResolvedHome;
  pick: (im: Parameters<typeof pickImage>[1], alt?: string) => PickedImage | null;
  /** This block continues the one above (seam « join »): no hairline, no top spacing. */
  joined: boolean;
};

// ── Section frame + seams ──────────────────────────────────────────────────────
/** The home rhythm per « Espacement » — SYMMETRIC, so the seam hairline sits exactly
 *  midway between two sections: 56|56 phones, 64|64 sm, 80|80 lg (Standard). */
const HOME_PT = {
  default: "pt-14 sm:pt-16 lg:pt-20",
  tight: "pt-10 sm:pt-12 lg:pt-14",
  spacious: "pt-20 sm:pt-24 lg:pt-28",
  none: "pt-0",
} as const;
const HOME_PB = {
  default: "pb-14 sm:pb-16 lg:pb-20",
  tight: "pb-10 sm:pb-12 lg:pb-14",
  spacious: "pb-20 sm:pb-24 lg:pb-28",
  none: "pb-0",
} as const;
const homePad = (p?: BlockPresentation): keyof typeof HOME_PT =>
  p?.padding === "tight" || p?.padding === "spacious" || p?.padding === "none" ? p.padding : "default";

/** Every home section: ONE page ground (no tone, no full-bleed border), the canonical
 *  container (or edge-to-edge for the rail, which supplies its own), the home rhythm.
 *  `data-pad` feeds the last-section floor in globals.css. */
function HomeSection({
  p,
  joined,
  bleed,
  children,
}: {
  p?: BlockPresentation;
  joined?: boolean;
  bleed?: boolean;
  children: React.ReactNode;
}) {
  const pad = homePad(p);
  return (
    <section className="w-full scroll-mt-28">
      <div data-pad={pad} className={cn(!bleed && SECTION_CONTAINER, joined ? "pt-0" : HOME_PT[pad], HOME_PB[pad])}>
        {children}
      </div>
    </section>
  );
}

/** The very soft seam between two sections — the content column, short soft ends. */
function HomeRule() {
  return (
    <div aria-hidden className={SECTION_CONTAINER}>
      <div className="tk-home-rule" />
    </div>
  );
}

/** A photo / framed banner is its own boundary — no hairline beside it in « Automatique »
 *  (the hero too, wherever the operator places it: never a line touching the carousel). */
const MEDIA_LED: ReadonlySet<HomeBlockType> = new Set(["hero", "banner_duo", "cta_band", "banner", "spacer"]);

export function HomeBlocksRenderer({
  resolved,
  fallbackHeading,
}: {
  /** null on a DB hiccup — the home degrades to the fallback h1 only (never a 500). */
  resolved: ResolvedHome | null;
  /** The page <h1> when no hero carousel renders (the hero always prints the h1). */
  fallbackHeading?: string;
}) {
  // Degrade to exactly the fallback h1 when data failed to resolve — the page keeps one
  // h1 and never emits an empty body (matches the route's "home never 500s" contract).
  if (!resolved) {
    return (
      <div className="tk-page tk-home">
        {fallbackHeading && <h1 className="sr-only">{fallbackHeading}</h1>}
      </div>
    );
  }
  const ctx: Ctx = { r: resolved, pick: (im, alt) => pickImage(resolved.media, im, alt), joined: false };
  // Every hero block reads the SAME slide list (Bannières → home_hero) and prints the page
  // <h1>, so only the FIRST visible one renders — a duplicate would be a second identical
  // carousel and a second h1.
  const firstHero = resolved.blocks.find((b) => b.visible && b.type === "hero")?.id;
  const visible = resolved.blocks.filter((b) => b.visible && (b.type !== "hero" || b.id === firstHero));

  // Render once to learn which blocks actually render (a block with nothing to show must
  // never leave a double hairline), plan the seams on that sequence (pure, unit-tested),
  // then re-render only the « Enchaîner » blocks without their top spacing.
  const first = visible.map((b) => ({ b, el: renderBlock(b, ctx) }));
  const seams = planSeams(
    first.map(({ b, el }) => ({
      type: b.type,
      mediaLed: MEDIA_LED.has(b.type),
      separator: b.config.separator,
      renders: Boolean(el),
    })),
  );
  const els = first.map(({ b, el }, i) => {
    if (!el) return null;
    const seam = seams[i];
    return (
      <Fragment key={b.id}>
        {seam === "rule" && <HomeRule />}
        {seam === "join" ? renderBlock(b, { ...ctx, joined: true }) : el}
      </Fragment>
    );
  });
  const heroPrintsH1 = visible.some((b) => b.type === "hero") && resolved.heroSlides.length > 0;

  return (
    // `tk-page` = the content pages' AA-legible muted copy on Ivoire (globals.css).
    <div className="tk-page tk-home">
      {!heroPrintsH1 && fallbackHeading && <h1 className="sr-only">{fallbackHeading}</h1>}
      {els}
    </div>
  );
}

// ── Shared helpers ─────────────────────────────────────────────────────────────
/** The block's own CTA when it is a real link, else the given continuation. */
function moreLink(h: BlockHeader, fallback: { href: string; label: string }): { href: string; label: string } {
  const own = realHref(safeHref(h.ctaHref));
  return own ? { href: own, label: h.ctaLabel || fallback.label } : { href: fallback.href, label: h.ctaLabel || fallback.label };
}

/** The quiet « continuation » link (Voir tout / Toutes les marques…) — underlined small
 *  caps + a hairline arrow, identical to the rail head. Real links only. */
function MoreLink({ href, label }: { href: string; label: string }) {
  if (!realHref(safeHref(href))) return null;
  return (
    <SmartLink href={href} className={QUIET_LINK}>
      <span className={QUIET_LINK_LABEL}>{label}</span>
      <ArrowRight className={QUIET_LINK_ARROW} strokeWidth={1.25} aria-hidden />
    </SmartLink>
  );
}

/** The block's own header CTA as a quiet continuation link — only when the operator set
 *  both a label and a real link (MoreLink drops `#` / unsafe hrefs). */
function headerLink(h: BlockHeader): React.ReactNode {
  return h.ctaLabel && realHref(safeHref(h.ctaHref)) ? <MoreLink href={h.ctaHref} label={h.ctaLabel} /> : undefined;
}

/** Vitrine cards only: a product shot to CONTAIN on the lit vitrine rather than crop — the
 *  kit's packshot test (≈square or a `-nobg` cut-out) OR a SMALL catalogue-sized
 *  portrait/square file (≤ 800px: white-ground JPEG packshots are ~446×559; cropped edge-
 *  to-edge they read as stark white slabs, while on the vitrine the multiply blend
 *  dissolves the white). Real photographs are larger, so they still crop edge-to-edge. */
function isProductShot(img: PickedImage): boolean {
  if (isPackshot(img)) return true;
  const w = img.width ?? 0;
  const h = img.height ?? 0;
  if (!w || !h) return false;
  const r = w / h;
  return Math.max(w, h) <= 800 && r >= 0.7 && r <= 1.35;
}

/** A link whose only content is an image needs a name even when the médiathèque alt is
 *  blank — a visually hidden label (the alt when present, else a neutral one). */
function LinkName({ show, label }: { show: boolean; label: string }) {
  return show ? <span className="sr-only">{label}</span> : null;
}

function renderBlock(b: HomeBlock, ctx: Ctx): React.ReactNode {
  const c = b.config;
  const p = c.presentation;
  const h = c.header ?? EMPTY_H;
  const align = p?.align ?? "left";

  switch (b.type) {
    case "hero": {
      const slides: HomeHeroSlide[] = ctx.r.heroSlides.map((s) => ({
        eyebrow: s.eyebrow ?? "",
        title: s.title ?? "",
        subtitle: s.subtitle ?? "",
        description: s.description ?? "",
        // Already sanitised + safe-href'd at the read seam (effectiveBannerButtons).
        buttons: s.buttons,
        image: (s.image ?? null) as ProductImage | null,
        imageMobile: (s.imageMobile ?? null) as ProductImage | null,
        video: s.video ?? null,
        imageAlt: s.imageAlt ?? null,
        showText: s.showText,
      }));
      if (slides.length === 0) return null;
      return <HomeHero slides={slides} />;
    }

    case "product_rail": {
      const products = ctx.r.productsByBlock.get(b.id) ?? [];
      if (products.length === 0) return null;
      const t = heading(h.title, c.accent);
      const href = realHref(safeHref(h.ctaHref)) || sourceListingHref(c.source, ctx.r.hiddenShowcase);
      return (
        // The rail supplies its own head container + an edge-aligned track, so the
        // section is edge-to-edge (`bleed`) and only carries the rhythm.
        <HomeSection p={p} joined={ctx.joined} bleed>
          <HomeRail
            eyebrow={h.eyebrow}
            title={t.text}
            accent={t.accent} accentStyle={c.accentStyle}
            subtitle={h.subtitle}
            more={href ? { href, label: h.ctaLabel || "Voir tout" } : null}
            products={products}
            // Unique per rail for analytics attribution (two untitled rails must not both
            // report « home_rail »); the operator title leads when set, else the block id.
            listName={h.title || `home_rail_${b.id}`}
            align={align}
          />
        </HomeSection>
      );
    }

    case "product_grid": {
      const products = ctx.r.productsByBlock.get(b.id) ?? [];
      if (products.length === 0) return null;
      const t = heading(h.title, c.accent);
      const href = realHref(safeHref(h.ctaHref)) || sourceListingHref(c.source, ctx.r.hiddenShowcase);
      return (
        <HomeSection p={p} joined={ctx.joined}>
          <HeadRow
            eyebrow={h.eyebrow}
            title={t.text}
            accent={t.accent} accentStyle={c.accentStyle}
            subtitle={h.subtitle}
            align={align}
            splitAt="md"
            aside={href ? <MoreLink href={href} label={h.ctaLabel || "Voir tout"} /> : undefined}
          />
          {/* tk-native-tokens: the cards (and the grid) render exactly as on the listing. */}
          <div className="tk-native-tokens">
            <ProductGrid products={products} />
          </div>
        </HomeSection>
      );
    }

    case "fifty_fifty":
      return renderVitrineCards(b, ctx);
    case "feature_cards":
      return renderComplications(b, ctx);
    case "editorial":
      return renderEditorial(b, ctx);
    // « Bannière » (média group) and « Bandeau CTA » (éditorial group) intentionally share
    // one renderer — same image-frame / no-image-panel behaviour; they differ only as two
    // palette entries so the operator finds the block under either mental model.
    case "cta_band":
    case "banner":
      return renderCta(b, ctx);
    case "banner_duo": {
      // Pair each slot with its own optional link BEFORE dropping empty slots.
      const slots = [
        { id: c.bannerId, href: c.bannerHref },
        { id: c.bannerId2, href: c.bannerHref2 },
      ]
        .map((s) => ({ image: s.id ? ctx.pick({ mediaId: s.id, alt: "" }) : null, href: realHref(safeHref(s.href ?? "")) }))
        .filter((s): s is { image: PickedImage; href: string } => Boolean(s.image));
      if (slots.length === 0) return null;
      // « Pleine largeur » → the two tiles bleed edge-to-edge as a split-screen band (no
      // rounding, no gap); otherwise the usual rounded tiles inside the 1400 column.
      const full = p?.width === "full";
      return (
        <HomeSection p={p} joined={ctx.joined} bleed={full}>
          <div className={cn("grid", full ? "gap-0" : GRID_GAP_TILES, slots.length > 1 && "md:grid-cols-2")}>
            {slots.map((s, i) => {
              const frame = (
                <MediaFrame
                  image={s.image}
                  fit="cover"
                  aspect={full ? "aspect-[4/3] sm:aspect-[3/2] md:aspect-[4/3]" : "aspect-[4/3] md:aspect-[3/2]"}
                  rounded={full ? "rounded-none" : undefined}
                />
              );
              return s.href ? (
                <SmartLink
                  key={i}
                  href={s.href}
                  className={cn(
                    "block focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-foreground/60",
                    !full && "rounded-[1.75rem]",
                  )}
                >
                  {frame}
                  <LinkName show={!s.image.alt} label="Voir la sélection" />
                </SmartLink>
              ) : (
                <div key={i}>{frame}</div>
              );
            })}
          </div>
        </HomeSection>
      );
    }
    case "categories":
      return renderCategories(b, ctx);
    case "brands":
      return renderBrands(b, ctx);
    case "trust":
      return renderTrust(b, ctx);
    case "steps":
      return renderSteps(b, ctx);
    case "faq":
      return renderFaq(b, ctx);
    case "rich_text":
      return renderRichText(b, ctx);
    case "testimonials":
      return renderTestimonials(b, ctx);
    case "stats":
      return renderStats(b, ctx);
    case "spacer":
      return renderSpacer(b);
    default: {
      // Exhaustiveness guard: adding a HOME_BLOCK_TYPE without a render case here is now a
      // COMPILE error (b.type no longer narrows to never), so a block can never silently
      // render nothing because its case was forgotten.
      const _exhaustive: never = b.type;
      return _exhaustive ?? null;
    }
  }
}

// ── Testimonials / avis ────────────────────────────────────────────────────────
function renderTestimonials(b: HomeBlock, ctx: Ctx): React.ReactNode {
  const c = b.config;
  const h = c.header ?? EMPTY_H;
  const items = (c.testimonials ?? []).filter((x) => x.quote || x.author || x.image);
  if (items.length === 0) return null;
  const t = heading(h.title, c.accent);
  const one = items.length === 1;
  return (
    <HomeSection p={c.presentation} joined={ctx.joined}>
      <HeadRow eyebrow={h.eyebrow} title={t.text} accent={t.accent} accentStyle={c.accentStyle} subtitle={h.subtitle} align={c.presentation?.align ?? "left"} splitAt="md" aside={headerLink(h)} />
      <ul className={cn("grid", one ? "mx-auto max-w-3xl" : cn(GRID_GAP_CARDS, colsFor(items.length, 3)))}>
        {items.map((x, i) => {
          const avatar = ctx.pick(x.image, x.author);
          return (
            <li key={i} className={cn("flex flex-col", one ? "items-center text-center" : "border-t border-border/50 pt-8")}>
              <span aria-hidden className="font-serif text-5xl leading-none text-gold/60">“</span>
              {x.quote && (
                <p className={cn("-mt-4 font-serif italic leading-snug text-foreground", one ? "text-2xl sm:text-[1.9rem]" : "text-xl")}>
                  {x.quote}
                </p>
              )}
              {(x.author || avatar || x.meta) && (
                <div className={cn("mt-6 flex items-center gap-3", one && "justify-center")}>
                  {avatar && <img src={avatar.src} alt={avatar.alt} loading="lazy" decoding="async" className="h-11 w-11 shrink-0 rounded-full object-cover" />}
                  <div className="min-w-0">
                    {x.author && <p className="font-body text-sm font-semibold text-foreground">{x.author}</p>}
                    {x.meta && <p className={cn(CARD_LABEL, "mt-0.5")}>{x.meta}</p>}
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </HomeSection>
  );
}

// ── Stats strip (brand figures) ────────────────────────────────────────────────
function renderStats(b: HomeBlock, ctx: Ctx): React.ReactNode {
  const c = b.config;
  const h = c.header ?? EMPTY_H;
  const items = (c.stats ?? []).filter((x) => x.value || x.label);
  if (items.length === 0) return null;
  const t = heading(h.title, c.accent);
  return (
    <HomeSection p={c.presentation} joined={ctx.joined}>
      {/* HeadRow self-guards (returns null when every part is blank), so calling it
          unconditionally lets a CTA-only header still render its « Voir tout » link. */}
      <HeadRow eyebrow={h.eyebrow} title={t.text} accent={t.accent} accentStyle={c.accentStyle} subtitle={h.subtitle} align={c.presentation?.align ?? "left"} splitAt="md" aside={headerLink(h)} />
      <dl className={cn("grid gap-x-8 gap-y-10 border-t border-border/50 pt-10", colsFor(items.length, 4))}>
        {items.map((x, i) => (
          <div key={i}>
            <dt className="font-serif text-[2.6rem] leading-none tracking-tight text-foreground tabular-nums sm:text-5xl">{x.value}</dt>
            <dd className={cn(CARD_LABEL, "mt-3")}>{x.label}</dd>
          </div>
        ))}
      </dl>
    </HomeSection>
  );
}

// ── Spacer (pure vertical gap) ─────────────────────────────────────────────────
const SPACER_H = { sm: "h-10 sm:h-14", md: "h-16 sm:h-24", lg: "h-24 sm:h-36", xl: "h-36 sm:h-52" } as const;
function renderSpacer(b: HomeBlock): React.ReactNode {
  const c = b.config;
  const height = c.spacerHeight ?? "md";
  const ornament = c.spacerOrnament ?? "none";
  // A spacer owns its OWN gap, so the section carries no extra rhythm (padding none).
  return (
    <section className="w-full" aria-hidden>
      <div className={cn(SPACER_H[height], "flex items-center", ornament !== "none" && SECTION_CONTAINER)}>
        {ornament === "rule" && <div className="tk-home-rule w-full" />}
        {ornament === "mark" && <span className="mx-auto font-serif text-2xl text-gold/50">✦</span>}
      </div>
    </section>
  );
}

// ── Vitrine duo (fifty_fifty) ──────────────────────────────────────────────────
/** A card visual: a product shot is CONTAINED on the lit vitrine panel (a 4px rise when
 *  the card is a link); a lifestyle photo is cropped edge-to-edge (a 2% zoom when linked). */
function CardVisual({ image, aspect }: { image: PickedImage | null; aspect: string }) {
  if (image && !isProductShot(image)) {
    return (
      <div className={cn("relative w-full overflow-hidden rounded-[1.75rem] bg-muted", aspect)}>
        <img
          src={image.src}
          alt={image.alt}
          loading="lazy"
          decoding="async"
          className={cn(
            "absolute inset-0 h-full w-full object-cover transition-[scale] duration-[1800ms] motion-safe:group-hover:scale-[1.02]",
            EASE,
          )}
        />
      </div>
    );
  }
  return (
    <div className={cn("tk-vitrine relative grid w-full place-items-center overflow-hidden rounded-[1.75rem]", aspect)}>
      {image && (
        <img
          src={image.src}
          alt={image.alt}
          loading="lazy"
          decoding="async"
          className={cn(
            "h-[64%] w-auto max-w-[66%] object-contain drop-shadow-[0_22px_28px_rgba(43,40,37,0.14)] transition-[translate] duration-1000 motion-safe:group-hover:-translate-y-1",
            EASE,
          )}
        />
      )}
    </div>
  );
}

function renderVitrineCards(b: HomeBlock, ctx: Ctx): React.ReactNode {
  const c = b.config;
  const p = c.presentation;
  const h = c.header ?? EMPTY_H;
  const cards = (c.cards ?? []).filter((card) => card.title || card.body || card.image || card.eyebrow || card.meta);
  if (cards.length === 0) return null;
  const t = heading(h.title, c.accent);
  const aspect = cards.length === 1 ? "aspect-[4/3] md:aspect-[21/9]" : "aspect-[5/4]";
  return (
    <HomeSection p={p} joined={ctx.joined}>
      <HeadRow eyebrow={h.eyebrow} title={t.text} accent={t.accent} accentStyle={c.accentStyle} subtitle={h.subtitle} align={p?.align ?? "left"} splitAt="md" aside={headerLink(h)} />
      <div className={cn("grid", GRID_GAP_CARDS, colsFor(cards.length, 3))}>
        {cards.map((card, i) => {
          const image = ctx.pick(card.image, card.title);
          const href = realHref(safeHref(card.ctaHref));
          const body = (
            <article className="flex h-full flex-col">
              <CardVisual image={image} aspect={aspect} />
              <div className="mt-6 min-w-0">
                {card.eyebrow && <p className={cn(CARD_LABEL, "mb-2.5 truncate")}>{card.eyebrow}</p>}
                {card.title && <h3 className="font-serif text-2xl leading-tight text-foreground sm:text-[1.75rem]">{card.title}</h3>}
                {card.body && <p className="mt-2 max-w-md font-body text-sm leading-relaxed text-muted-foreground">{card.body}</p>}
                {card.meta && <p className={cn(CARD_META, "mt-3")}>{card.meta}</p>}
                {/* The whole card is the link; a visible label only when the operator wrote one. */}
                {href && card.ctaLabel && <span className={cn(CARD_CTA, "mt-5")}>{card.ctaLabel}</span>}
              </div>
            </article>
          );
          return href ? (
            <SmartLink key={i} href={href} className="group block h-full">
              {body}
              <LinkName show={!card.title && !card.body && !card.eyebrow && !image?.alt} label={card.ctaLabel || "Découvrir"} />
            </SmartLink>
          ) : (
            // Not a link → no `group`, so nothing moves on hover.
            <div key={i}>{body}</div>
          );
        })}
      </div>
    </HomeSection>
  );
}

// ── Complications (feature_cards) ──────────────────────────────────────────────
/** Columns by card count — 3 or 4 dark cards never squeeze into a cramped tablet row. */
const FEATURE_COLS = {
  1: "grid-cols-1",
  2: "grid-cols-1 sm:grid-cols-2",
  3: "grid-cols-1 md:grid-cols-3",
  4: "grid-cols-1 sm:grid-cols-2 xl:grid-cols-4",
} as const;

function renderComplications(b: HomeBlock, ctx: Ctx): React.ReactNode {
  const c = b.config;
  const p = c.presentation;
  const h = c.header ?? EMPTY_H;
  const cards = (c.cards ?? []).filter((card) => card.title || card.body || card.image || card.eyebrow || card.meta);
  if (cards.length === 0) return null;
  const t = heading(h.title, c.accent);
  const n = Math.min(cards.length, 4) as 1 | 2 | 3 | 4;
  // Three across from md: tighten the card padding / title so the copy never crams.
  const dense = n === 3;
  return (
    <HomeSection p={p} joined={ctx.joined}>
      <HeadRow eyebrow={h.eyebrow} title={t.text} accent={t.accent} accentStyle={c.accentStyle} subtitle={h.subtitle} align={p?.align ?? "left"} splitAt="md" aside={headerLink(h)} />
      <div className={cn("grid", GRID_GAP_TILES, FEATURE_COLS[n])}>
        {cards.map((card, i) => {
          const image = ctx.pick(card.image, card.title);
          const href = realHref(safeHref(card.ctaHref));
          const body = (
            // A card-level dark moment (« Cartes sombres »): tk-tone-dark re-declares the
            // palette locally, so copy, labels and hairlines inside flip to ivory on their own.
            <article
              className={cn("tk-tone-dark flex h-full flex-col rounded-[1.75rem]", dense ? "p-7 md:p-6 lg:p-8 xl:p-9" : "p-7 sm:p-9")}
            >
              {card.eyebrow && <p className={cn(CARD_LABEL, "truncate")}>{card.eyebrow}</p>}
              {image && (
                // A lit display window inside the dark card — white-ground packshots melt
                // into it (multiply) instead of sitting as white rectangles on onyx.
                <div
                  className={cn(
                    "tk-vitrine-lit grid aspect-[4/3] place-items-center overflow-hidden rounded-[1.25rem]",
                    dense ? "my-8 md:my-6 lg:my-8" : "my-8",
                  )}
                >
                  <img
                    src={image.src}
                    alt={image.alt}
                    loading="lazy"
                    decoding="async"
                    // The owner's chosen hover: the watch floats up and leans outward (the
                    // pair lean in opposite directions) — `.watch-tilt-*` in globals.css.
                    className={cn(
                      "h-[70%] w-auto max-w-[70%] object-contain drop-shadow-[0_18px_24px_rgba(43,40,37,0.14)] motion-safe:group-hover:-translate-y-2",
                      i % 2 === 0 ? "watch-tilt-cw" : "watch-tilt-ccw",
                    )}
                  />
                </div>
              )}
              <div className="mt-auto">
                {card.title && (
                  <h3
                    className={cn(
                      "font-serif leading-tight text-foreground",
                      dense ? "text-2xl md:text-xl lg:text-2xl xl:text-[1.75rem]" : "text-2xl sm:text-[1.75rem]",
                    )}
                  >
                    {card.title}
                  </h3>
                )}
                {card.body && <p className="mt-3 max-w-md font-body text-sm leading-relaxed text-muted-foreground">{card.body}</p>}
                {(card.meta || (href && card.ctaLabel)) && (
                  <div className="mt-7 flex flex-wrap items-end justify-between gap-x-4 gap-y-3 border-t border-border/60 pt-5">
                    {card.meta ? <p className={CARD_META}>{card.meta}</p> : <span />}
                    {href && card.ctaLabel && <span className={CARD_CTA}>{card.ctaLabel}</span>}
                  </div>
                )}
              </div>
            </article>
          );
          return href ? (
            <SmartLink key={i} href={href} className="group block h-full">
              {body}
              <LinkName show={!card.title && !card.body && !card.eyebrow && !image?.alt} label={card.ctaLabel || "Découvrir"} />
            </SmartLink>
          ) : (
            <div key={i} className="h-full">
              {body}
            </div>
          );
        })}
      </div>
    </HomeSection>
  );
}

// ── Editorial split ────────────────────────────────────────────────────────────
function renderEditorial(b: HomeBlock, ctx: Ctx): React.ReactNode {
  const c = b.config;
  const h = c.header ?? EMPTY_H;
  const t = heading(h.title, c.accent);
  const desktop = ctx.pick(c.image, t.text);
  const mobileImg = ctx.pick(c.imageMobile, t.text);
  // Desktop is the base; a mobile-only image is still shown (not dropped). The mobile crop is
  // an art-directed <source> only when both crops exist.
  const image = desktop ?? mobileImg;
  const mobile = desktop && mobileImg ? mobileImg : null;
  // Hide-when-unset, symmetric with what the block renders (eyebrow / subtitle / CTA count).
  if (!t.text && !t.accent && !c.body && !image && !h.eyebrow && !h.subtitle && !hasCta(h)) return null;
  const copy = (
    <div>
      {h.eyebrow && <Eyebrow>{h.eyebrow}</Eyebrow>}
      <Title text={t.text} accent={t.accent} accentStyle={c.accentStyle} className={H_SECTION} />
      <div className="luxury-divider mt-7 max-w-[80px]" />
      {h.subtitle && <p className="mt-6 font-serif text-lg italic leading-[1.6] text-foreground/70 sm:text-xl">{h.subtitle}</p>}
      {c.body && <p className={cn(BODY, "mt-6 max-w-xl")}>{c.body}</p>}
      <CtaPair className="mt-9" primary={{ label: h.ctaLabel, href: h.ctaHref }} primaryVariant="secondary" />
    </div>
  );
  if (!image) {
    return (
      <HomeSection p={c.presentation} joined={ctx.joined}>
        <div className="tk-fade-in-up max-w-3xl">{copy}</div>
      </HomeSection>
    );
  }
  const left = c.imageSide === "left";
  const portrait = isPortrait(image);
  const mPortrait = mobile ? isPortrait(mobile) : portrait;
  // Portrait photo → 5/12 media + 6/12 text; landscape → 6/12 media, a breathing column,
  // 5/12 text — on the same grid lines (gap-x-10) as every head row aside.
  const mediaCls = portrait
    ? left ? "lg:col-span-5 lg:col-start-1" : "lg:col-span-5 lg:col-start-8"
    : left ? "lg:col-span-6 lg:col-start-1" : "lg:col-span-6 lg:col-start-7";
  const textCls = portrait
    ? left ? "lg:col-span-6 lg:col-start-7" : "lg:col-span-6 lg:col-start-1"
    : left ? "lg:col-span-5 lg:col-start-8" : "lg:col-span-5 lg:col-start-1";
  // Stacked (below lg) a full-width 4:5 portrait would fill a whole tablet screen: phones
  // keep the portrait read, tablets get a calmer 5:4 frame, desktop the 4:5 column.
  const aspect = portrait
    ? mPortrait
      ? "aspect-[4/5] sm:aspect-[5/4] lg:aspect-[4/5]"
      : "aspect-[3/2] sm:aspect-[5/4] lg:aspect-[4/5]"
    : mPortrait
      ? "aspect-[4/5] sm:aspect-[4/3]"
      : "aspect-[4/3]";
  return (
    <HomeSection p={c.presentation} joined={ctx.joined}>
      <div className="grid items-center gap-y-10 lg:grid-cols-12 lg:gap-x-10">
        <div className={cn(mediaCls, "lg:row-start-1")}>
          <MediaFrame image={image} mobile={mobile} aspect={aspect} />
        </div>
        <div className={cn(textCls, "tk-fade-in-up lg:row-start-1")}>{copy}</div>
      </div>
    </HomeSection>
  );
}

// ── CTA band / banner ──────────────────────────────────────────────────────────
function renderCta(b: HomeBlock, ctx: Ctx): React.ReactNode {
  const c = b.config;
  const p = c.presentation;
  const h = c.header ?? EMPTY_H;
  const align = p?.align ?? "left";
  const t = heading(h.title, c.accent);
  const desktop = ctx.pick(c.image, t.text);
  const mobileImg = ctx.pick(c.imageMobile, t.text);
  // Use the desktop image as the base, else fall back to a mobile-only image (otherwise a
  // banner with ONLY a mobile image set would render with no photo at all). The mobile crop
  // becomes an art-directed <source> only when BOTH crops exist.
  const image = desktop ?? mobileImg;
  const mobile = desktop && mobileImg ? mobileImg : null;
  // Hide only when there is nothing to show — a CTA-only band (eyebrow + subtitle + button,
  // blank Titre) still renders through the no-image PANEL branch.
  if (!image && !t.text && !t.accent && !h.eyebrow && !h.subtitle && !hasCta(h)) return null;
  const target = realHref(safeHref(h.ctaHref));

  if (image) {
    // « Pleine largeur » (operator Largeur control) → an edge-to-edge 100vw photo break.
    const full = p?.width === "full";
    // A labelled CTA is a real button on a plain frame (never a link inside a link); a
    // link with NO label makes the whole frame the link, with a corner arrow affordance.
    const button = Boolean(h.ctaLabel && target);
    const frameHref = button ? "" : target;
    // Phones: a tall frame. From sm: a landscape frame (wider when full-bleed). The frame
    // itself does NOT clip (the photo layer does), so it is not a scroll container and its
    // aspect ratio's automatic minimum grows it to fit long copy — never clipped.
    const frameCls = full
      ? "group relative flex min-h-[26rem] items-end sm:min-h-auto sm:aspect-[21/9] lg:aspect-[32/9]"
      : "group relative flex min-h-[24rem] items-end rounded-[1.75rem] sm:aspect-[16/9] sm:min-h-auto lg:aspect-[21/9]";
    const copy = (
      <>
        {h.eyebrow && <p className="mb-4 font-body text-[0.66rem] uppercase tracking-[0.26em] text-white/90">{h.eyebrow}</p>}
        {(t.text || t.accent) && (
          <h2 className={cn(H_SECTION, "text-balance font-serif font-normal text-white")}>
            {t.text}
            {t.accent && <span className={cn("block italic", ON_PHOTO_ACCENT)}>{t.accent}</span>}
          </h2>
        )}
        {h.subtitle && <p className="mt-4 max-w-lg font-body text-sm leading-relaxed text-white/85 md:text-base">{h.subtitle}</p>}
        {button && (
          <div className={cn("mt-8 flex", align === "center" && "justify-center")}>
            <SmartLink href={target} className={buttonVariants({ variant: "secondary", size: "md", onDark: true })}>
              <span className="btn__label">{h.ctaLabel}</span>
            </SmartLink>
          </div>
        )}
      </>
    );
    const inner = (
      <>
        <div className={cn("absolute inset-0 overflow-hidden", !full && "rounded-[1.75rem]")}>
          <picture>
            {mobile && <source media="(max-width: 639px)" srcSet={mobile.src} />}
            <img
              src={image.src}
              alt={image.alt}
              loading="lazy"
              decoding="async"
              className={cn(
                "absolute inset-0 h-full w-full object-cover",
                frameHref && cn("transition-[scale] duration-[1800ms] motion-safe:group-hover:scale-[1.02]", EASE),
              )}
            />
          </picture>
          <div aria-hidden className="absolute inset-0 bg-gradient-to-t from-black/65 via-black/20 to-transparent" />
          <div aria-hidden className="absolute inset-0 bg-gradient-to-r from-black/35 via-transparent to-transparent" />
        </div>
        {/* Full-bleed: the PHOTO bleeds to the viewport edge, but the copy stays in the 1400
            column (luxury convention — bleed the image, not the text). */}
        {full ? (
          <div className="relative z-10 w-full">
            <div className={cn(SECTION_CONTAINER, "py-12 sm:py-16 lg:py-20")}>
              <div className={align === "center" ? "mx-auto max-w-2xl text-center" : "max-w-2xl"}>{copy}</div>
            </div>
          </div>
        ) : (
          <div className={cn("relative z-10 w-full p-7 sm:p-10 lg:p-14", align === "center" ? "mx-auto max-w-2xl text-center" : "max-w-2xl")}>
            {copy}
          </div>
        )}
        {frameHref && (
          <ArrowUpRight
            aria-hidden
            strokeWidth={1.25}
            className="absolute bottom-8 right-8 z-10 hidden h-5 w-5 text-white/70 transition-colors duration-500 group-hover:text-white md:block"
          />
        )}
        <LinkName show={Boolean(frameHref) && !t.text && !t.accent && !h.eyebrow && !h.subtitle && !image.alt} label="Découvrir" />
      </>
    );
    return (
      <HomeSection p={p} joined={ctx.joined} bleed={full}>
        {frameHref ? (
          <SmartLink href={frameHref} className={frameCls}>
            {inner}
          </SmartLink>
        ) : (
          <div className={frameCls}>{inner}</div>
        )}
      </HomeSection>
    );
  }

  // No image → the home's quiet PANEL (one soft greige, hairline frame) — never an empty
  // 21:9 slab, never a hardcoded onyx island.
  const primary = { label: h.ctaLabel, href: h.ctaHref };
  return (
    <HomeSection p={p} joined={ctx.joined}>
      <div className={cn(PANEL, "px-7 py-12 sm:px-10 lg:px-14 lg:py-16")}>
        {align === "center" ? (
          <div className="mx-auto max-w-2xl text-center">
            {h.eyebrow && <Eyebrow className="justify-center">{h.eyebrow}</Eyebrow>}
            <Title text={t.text} accent={t.accent} accentStyle={c.accentStyle} className={H_SECTION} />
            {h.subtitle && <p className={cn(BODY, "mx-auto mt-4 max-w-xl")}>{h.subtitle}</p>}
            <CtaPair className="mt-8 justify-center" primary={primary} primaryVariant="secondary" />
          </div>
        ) : (
          <div className="grid gap-8 md:grid-cols-12 md:items-center md:gap-x-8 lg:gap-x-10">
            <div className="md:col-span-7">
              {h.eyebrow && <Eyebrow>{h.eyebrow}</Eyebrow>}
              <Title text={t.text} accent={t.accent} accentStyle={c.accentStyle} className={H_SECTION} />
              {h.subtitle && <p className={cn(BODY, "mt-4 max-w-xl")}>{h.subtitle}</p>}
            </div>
            <CtaPair className="md:col-span-5 md:justify-end" primary={primary} primaryVariant="secondary" />
          </div>
        )}
      </div>
    </HomeSection>
  );
}

// ── Categories — directory ─────────────────────────────────────────────────────
function renderCategories(b: HomeBlock, ctx: Ctx): React.ReactNode {
  const c = b.config;
  const h = c.header ?? EMPTY_H;
  const refs = c.refs ?? [];
  const all = ctx.r.categories;
  // The operator's picks, in their order; if none resolves any more (deactivated /
  // renamed), fall back to the automatic selection rather than hiding the block.
  const picked = refs.map((s) => all.find((x) => x.slug === s)).filter(Boolean) as typeof all;
  let list = picked.length > 0 ? picked : all;
  list = list.slice(0, c.count ?? 12);
  if (list.length === 0) return null;
  const t = heading(h.title, c.accent);
  const more = moreLink(h, { href: "/boutique", label: "Toute la boutique" });
  return (
    <HomeSection p={c.presentation} joined={ctx.joined}>
      <HeadRow
        eyebrow={h.eyebrow}
        title={t.text}
        accent={t.accent} accentStyle={c.accentStyle}
        subtitle={h.subtitle}
        align={c.presentation?.align}
        splitAt="md"
        aside={<MoreLink href={more.href} label={more.label} />}
      />
      <ul className={cn("grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4", GRID_GAP_CARDS)}>
        {list.map((cat) => {
          // The category's « Image boutique » (as on /boutique) — never the small chip icon.
          const image = ctx.pick(cat.boutiqueImageMediaId ? { mediaId: cat.boutiqueImageMediaId, alt: "" } : null, cat.name);
          // Same rule as /boutique: a photo covers the tile; only a true cut-out (-nobg /
          // ≈square) is contained on the vitrine.
          const packshot = image ? isPackshot(image) : true;
          return (
            <li key={cat.slug}>
              <Link href={`/${cat.slug}`} className="group block">
                <div
                  className={cn(
                    "relative aspect-[4/5] overflow-hidden rounded-[1.75rem]",
                    packshot ? "tk-vitrine grid place-items-center" : "bg-muted",
                  )}
                >
                  {image ? (
                    packshot ? (
                      <img
                        src={image.src}
                        alt={image.alt}
                        loading="lazy"
                        decoding="async"
                        className={cn(
                          "h-[62%] w-auto max-w-[66%] object-contain drop-shadow-[0_20px_24px_rgba(43,40,37,0.14)] transition-[translate] duration-1000 motion-safe:group-hover:-translate-y-1",
                          EASE,
                        )}
                      />
                    ) : (
                      <img
                        src={image.src}
                        alt={image.alt}
                        loading="lazy"
                        decoding="async"
                        className={cn(
                          "absolute inset-0 h-full w-full object-cover transition-[scale] duration-[1800ms] motion-safe:group-hover:scale-[1.02]",
                          EASE,
                        )}
                      />
                    )
                  ) : (
                    // No « Image boutique » yet → a typographic panel (never a lone initial).
                    <span aria-hidden className="px-5 text-center font-serif text-2xl leading-tight text-[#2b2825]/25 sm:text-3xl">
                      {cat.name}
                    </span>
                  )}
                </div>
                <p className="mt-4 truncate border-b border-border/50 pb-3 font-serif text-lg text-foreground/85 transition-colors duration-500 group-hover:border-foreground/40 group-hover:text-foreground sm:text-xl">
                  {cat.name}
                </p>
              </Link>
            </li>
          );
        })}
      </ul>
    </HomeSection>
  );
}

// ── Brands — the maison wall ───────────────────────────────────────────────────
function renderBrands(b: HomeBlock, ctx: Ctx): React.ReactNode {
  const c = b.config;
  const h = c.header ?? EMPTY_H;
  const refs = c.refs ?? [];
  const all = ctx.r.brands;
  // The operator's picks, in their order; if none resolves any more (deactivated /
  // renamed), fall back to the automatic selection rather than hiding the block.
  const picked = refs.map((s) => all.find((x) => x.slug === s)).filter(Boolean) as typeof all;
  let list = picked.length > 0 ? picked : all;
  list = list.slice(0, c.count ?? 12);
  if (list.length === 0) return null;
  const t = heading(h.title, c.accent);
  const more = moreLink(h, { href: "/marques", label: "Toutes les marques" });
  return (
    <HomeSection p={c.presentation} joined={ctx.joined}>
      <HeadRow
        eyebrow={h.eyebrow}
        title={t.text}
        accent={t.accent} accentStyle={c.accentStyle}
        subtitle={h.subtitle}
        align={c.presentation?.align}
        splitAt="md"
        aside={<MoreLink href={more.href} label={more.label} />}
      />
      {/* A quiet ruled ledger with INNER rules only: each cell draws its right/bottom
          hairline and the wrapper clips the outermost ones — no heavy outer box, no open
          staircase corner when the count isn't a multiple of the columns. */}
      <div className="overflow-hidden">
        <div className="-mb-px -mr-px grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
          {list.map((brand, i) => (
            <Link
              key={brand.slug}
              href={`/${brand.slug}`}
              className={cn(
                // Hover: the cell lights softly, the name darkens and a short gold hairline
                // draws in beneath it — one quiet cue, nothing jumps.
                "group flex flex-col items-center justify-center gap-3 border-b border-r border-border/40 px-3 py-7 last:border-r-0 transition-colors duration-500 hover:bg-[var(--tk-home-panel)] focus-visible:bg-[var(--tk-home-panel)] focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-foreground/70 sm:py-9",
                EASE,
                // Phones show the first 8 (four rows) — « Toutes les marques » carries the rest.
                i >= 8 && "hidden sm:flex",
              )}
            >
              {brand.logoUrl ? (
                <>
                  <span className="grid h-12 w-full place-items-center">
                    <img
                      src={brand.logoUrl}
                      alt={brand.logoAlt ?? brand.name}
                      loading="lazy"
                      decoding="async"
                      className={cn(
                        "max-h-11 w-auto max-w-[80%] object-contain opacity-60 grayscale transition-opacity duration-700 group-hover:opacity-95 group-focus-visible:opacity-95",
                        EASE,
                      )}
                    />
                  </span>
                  <span className="w-full truncate text-center font-body text-[0.72rem] tracking-[0.04em] text-muted-foreground transition-colors duration-500 group-hover:text-foreground group-focus-visible:text-foreground">
                    {brand.name}
                  </span>
                </>
              ) : (
                // No logo in the médiathèque yet → a typographic wordmark (never a lone initial).
                <span className="grid min-h-12 w-full place-items-center text-center font-serif text-lg leading-tight text-foreground/70 transition-colors duration-500 group-hover:text-foreground group-focus-visible:text-foreground sm:text-xl">
                  {brand.name}
                </span>
              )}
              <span
                aria-hidden
                className={cn(
                  "h-px w-0 bg-gold/70 transition-[width] duration-500 group-hover:w-8 group-focus-visible:w-8 motion-reduce:transition-none",
                  EASE,
                )}
              />
            </Link>
          ))}
        </div>
      </div>
    </HomeSection>
  );
}

// ── Trust — reassurance strip ──────────────────────────────────────────────────
function renderTrust(b: HomeBlock, ctx: Ctx): React.ReactNode {
  const c = b.config;
  const h = c.header ?? EMPTY_H;
  const cards = (c.cards ?? []).filter((x) => x.title || x.body || x.eyebrow || x.icon || x.image);
  if (cards.length === 0) return null;
  const t = heading(h.title, c.accent);
  return (
    <HomeSection p={c.presentation} joined={ctx.joined}>
      <HeadRow eyebrow={h.eyebrow} title={t.text} accent={t.accent} accentStyle={c.accentStyle} subtitle={h.subtitle} align={c.presentation?.align ?? "left"} splitAt="md" aside={headerLink(h)} />
      <ul className={cn("grid", GRID_GAP_CARDS, colsFor(cards.length, 4))}>
        {cards.map((card, i) => {
          const Icon = valuePropIcon(card.icon);
          const image = ctx.pick(card.image, card.title);
          const href = realHref(safeHref(card.ctaHref));
          return (
            <li key={`${card.title}-${i}`} className="flex gap-4">
              {image ? (
                <img src={image.src} alt="" loading="lazy" decoding="async" className="h-9 w-9 shrink-0 rounded-full object-cover" />
              ) : (
                <Icon className="mt-1 h-5 w-5 shrink-0 text-foreground/55" strokeWidth={1.25} aria-hidden />
              )}
              <div className="min-w-0">
                {card.eyebrow && <p className={cn(CARD_LABEL, "mb-1.5")}>{card.eyebrow}</p>}
                {card.title && (
                  <h3 className="font-serif text-lg text-foreground">
                    {href ? (
                      <SmartLink
                        href={href}
                        className="border-b border-transparent transition-colors duration-500 hover:border-foreground/40"
                      >
                        {card.title}
                      </SmartLink>
                    ) : (
                      card.title
                    )}
                  </h3>
                )}
                {card.body && <p className="mt-1.5 font-body text-sm leading-relaxed text-muted-foreground">{card.body}</p>}
              </div>
            </li>
          );
        })}
      </ul>
    </HomeSection>
  );
}

// ── Steps ──────────────────────────────────────────────────────────────────────
function renderSteps(b: HomeBlock, ctx: Ctx): React.ReactNode {
  const c = b.config;
  const p = c.presentation;
  const h = c.header ?? EMPTY_H;
  const steps = (c.steps ?? []).filter((s) => s.title || s.body);
  if (steps.length === 0) return null;
  const t = heading(h.title, c.accent);
  return (
    <HomeSection p={p} joined={ctx.joined}>
      <HeadRow
        eyebrow={h.eyebrow}
        title={t.text}
        accent={t.accent} accentStyle={c.accentStyle}
        subtitle={h.subtitle}
        align={p?.align ?? "left"}
        splitAt="md"
        // Only a CTA that will actually render — an always-truthy element would emit an
        // empty aside column (extra blank space under the title).
        aside={hasCta(h) ? <CtaPair primary={{ label: h.ctaLabel, href: h.ctaHref }} primaryVariant="secondary" /> : undefined}
      />
      <ol className={cn("grid", GRID_GAP_CARDS, colsFor(steps.length, 5))}>
        {steps.map((s, i) => (
          <li key={i}>
            {/* Order is the content here, so it shows once — quietly (the <ol> already tells AT). */}
            <span aria-hidden className="block font-serif text-sm tabular-nums text-muted-foreground">
              {nn(i)}
            </span>
            <span aria-hidden className="mt-3 block h-px w-8 bg-border" />
            {s.title && <h3 className="mt-5 font-serif text-xl text-foreground">{s.title}</h3>}
            {s.body && <p className="mt-2 font-body text-sm leading-relaxed text-muted-foreground">{s.body}</p>}
          </li>
        ))}
      </ol>
    </HomeSection>
  );
}

// ── FAQ ────────────────────────────────────────────────────────────────────────
function renderFaq(b: HomeBlock, ctx: Ctx): React.ReactNode {
  const c = b.config;
  const h = c.header ?? EMPTY_H;
  const faq = (c.faq ?? []).map((q) => ({ question: q.question, answer: q.answer }));
  if (faq.length === 0) return null;
  const t = heading(h.title, c.accent);
  // No head at all (every header field blank) → the accordion takes the reading column
  // alone, without an empty sticky column beside it.
  const hasHead = Boolean(h.eyebrow || t.text || t.accent || h.subtitle || hasCta(h));
  return (
    <HomeSection p={c.presentation} joined={ctx.joined}>
      <div className="grid gap-y-8 lg:grid-cols-12 lg:gap-x-10">
        {hasHead && (
          <div className="tk-fade-in-up lg:sticky lg:top-28 lg:col-span-4 lg:self-start">
            <Eyebrow>{h.eyebrow}</Eyebrow>
            <Title text={t.text} accent={t.accent} accentStyle={c.accentStyle} className={H_SECTION} />
            {h.subtitle && <p className={cn(BODY, "mt-5")}>{h.subtitle}</p>}
            <CtaPair className="mt-7" primary={{ label: h.ctaLabel, href: h.ctaHref }} primaryVariant="secondary" />
          </div>
        )}
        <div className={hasHead ? "lg:col-span-7 lg:col-start-6" : "lg:col-span-8"}>
          <ProductFaqAccordion faqs={faq} accent={c.accentStyle === "ink" ? "ink" : "gold"} />
        </div>
      </div>
    </HomeSection>
  );
}

/** Will the header's CTA actually render (a label AND a real link)? */
function hasCta(h: BlockHeader): boolean {
  return Boolean(h.ctaLabel && realHref(safeHref(h.ctaHref)));
}

// ── Rich text ──────────────────────────────────────────────────────────────────
function renderRichText(b: HomeBlock, ctx: Ctx): React.ReactNode {
  const c = b.config;
  const h = c.header ?? EMPTY_H;
  const t = heading(h.title, c.accent);
  if (!t.text && !t.accent && !c.body && !h.subtitle && !h.eyebrow && !hasCta(h)) return null;
  const center = (c.presentation?.align ?? "center") !== "left";
  return (
    <HomeSection p={c.presentation} joined={ctx.joined}>
      {/* Left-aligned copy starts on the container edge like every head; centred copy
          sits in a centred reading column. */}
      <div className={cn("tk-fade-in-up w-full max-w-3xl", center && "mx-auto text-center")}>
        {h.eyebrow && <Eyebrow className={center ? "justify-center" : ""}>{h.eyebrow}</Eyebrow>}
        {(t.text || t.accent) && <Title text={t.text} accent={t.accent} accentStyle={c.accentStyle} className={cn(H_SECTION, "mb-6")} />}
        {h.subtitle && (
          <p className={cn("-mt-2 mb-6 font-serif text-lg italic leading-[1.6] text-foreground/70 sm:text-xl", center && "mx-auto max-w-2xl")}>
            {h.subtitle}
          </p>
        )}
        {c.body && (
          <p className="whitespace-pre-line font-body text-base leading-[1.85] text-muted-foreground sm:text-[1.05rem]">{c.body}</p>
        )}
        <CtaPair
          className={cn("mt-8", center && "justify-center")}
          primary={{ label: h.ctaLabel, href: h.ctaHref }}
          primaryVariant="secondary"
        />
      </div>
    </HomeSection>
  );
}
