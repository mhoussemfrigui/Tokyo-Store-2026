import { Fragment } from "react";
import Link from "next/link";
import Image from "next/image";
import { ArrowRight } from "lucide-react";

import { cn } from "@/lib/utils";
import { buttonVariants } from "@/components/ui/button";
import { ProductGrid } from "@/components/storefront/product-grid";
import { ProductFaqAccordion } from "@/components/product-faq";
import { valuePropIcon } from "@/lib/catalog/value-prop-icons";
import { sanitizeRichHtml } from "@/lib/sanitize/rich-html";
import { safeHref } from "@/lib/utils/safe-href";
import { SECTION_CONTAINER } from "@/lib/pages/block-model";
import type { ResolvedPage } from "@/lib/pages/page-blocks-data";
import {
  mapUrlsFor,
  realHref,
  telHref,
  yearsSinceLabel,
  type BlockPresentation,
  type PageBlock,
} from "@/lib/pages/page-blocks";
import {
  BODY,
  CtaPair,
  Eyebrow,
  H_DISPLAY,
  H_PAGE,
  H_SECTION,
  HeadRow,
  MediaFrame,
  PageSection,
  SmartLink,
  Title,
  colsFor,
  isPortrait,
  nn,
  pickImage,
  toneClass,
  type PickedImage,
} from "./blocks/kit";
import { ContactChannelsBlock } from "./blocks/contact-channels";
import { StoreAtlas, type AtlasStore } from "./blocks/store-atlas";
import { JobBoard, type BoardJob } from "./blocks/job-board";

/**
 * Storefront renderer for the PAGE block composer (a SERVER component).
 *
 * Layout contract (2026-10-01 redesign): every block uses the full canonical container
 * (the same 1400px column as the header, listing pages and footer) and composes on a
 * 12-column grid — no more centred 736/1024px islands. Sections are separated by tone.
 * Blocks expose per-type LAYOUT variants so pages built from one catalog can each have
 * their own identity. When the first visible block is an opener (hero, or a concierge
 * contact block) its title IS the page <h1>; otherwise an editorial masthead carries it.
 */

const PROSE_CLASS = "tk-prose max-w-none break-words";
const EMPTY_H = { eyebrow: "", title: "", subtitle: "", ctaLabel: "", ctaHref: "" };

type Ctx = {
  r: ResolvedPage;
  pick: (im: Parameters<typeof pickImage>[1], alt?: string) => PickedImage | null;
  now: Date;
};

/** The first visible block replaces the masthead ONLY if it will print the page heading
 *  (a titled hero / concierge contact block) — otherwise the masthead keeps the <h1>. */
const isOpener = (b: PageBlock | undefined) => {
  if (!b) return false;
  const titled = Boolean(b.config.header?.title || b.config.accent);
  if (b.type === "hero") return titled;
  return b.type === "contact_channels" && (b.config.layout ?? "concierge") === "concierge" && titled;
};

export function PageBlocksRenderer({ resolved }: { resolved: ResolvedPage }) {
  const { page, blocks, media } = resolved;
  const ctx: Ctx = { r: resolved, pick: (im, alt) => pickImage(media, im, alt), now: new Date() };

  const visibleBlocks = blocks.filter((b) => b.visible);
  const openerId = isOpener(visibleBlocks[0]) ? visibleBlocks[0].id : null;

  const els = visibleBlocks
    .map((b) => {
      const el = renderPageBlock(b, ctx, b.id === openerId ? 1 : 2);
      return el ? <Fragment key={b.id}>{el}</Fragment> : null;
    })
    .filter(Boolean);

  const lede = page.metaDescription?.trim();
  return (
    <div className="tk-page">
      {/* Editorial masthead for prose/legal pages (no opener block): a gold kicker, the
          Playfair <h1>, an optional lede and a single luxury divider. */}
      {!openerId && (
        <header className={cn(SECTION_CONTAINER, "tk-fade-in-up pt-16 text-center sm:pt-20 lg:pt-24")}>
          <div className="mb-5 flex items-center justify-center gap-3" aria-hidden>
            <span className="h-px w-8 bg-gold/45" />
            <span className="font-body text-[0.65rem] uppercase tracking-[0.32em] text-gold">Maison Tokyo</span>
            <span className="h-px w-8 bg-gold/45" />
          </div>
          <h1 className={cn("mx-auto max-w-4xl font-serif font-normal tracking-tight text-foreground", H_PAGE)}>{page.title}</h1>
          {lede && <p className={cn(BODY, "mx-auto mt-5 max-w-2xl")}>{lede}</p>}
          <div className="luxury-divider mx-auto mt-8 w-24" />
        </header>
      )}
      {els.length > 0 ? (
        <div className={openerId ? "" : "mt-2"}>{els}</div>
      ) : (
        <p className="mx-auto my-16 max-w-md px-5 text-center text-sm text-muted-foreground">
          Cette page sera bientôt disponible.
        </p>
      )}
    </div>
  );
}

function renderPageBlock(b: PageBlock, ctx: Ctx, level: 1 | 2): React.ReactNode {
  const c = b.config;
  const p = c.presentation;
  const h = c.header ?? EMPTY_H;
  const align = p?.align ?? "left";

  switch (b.type) {
    case "hero":
      return <HeroBlock b={b} ctx={ctx} level={level} />;

    case "rich_text": {
      // TipTap emits "<p></p>" (or "<p><br></p>") for an empty editor — treat a body
      // with no text/media as empty so the block doesn't render a blank band.
      const bodyHasContent =
        Boolean(c.body && c.body.replace(/<[^>]*>/g, "").replace(/&nbsp;/gi, " ").trim().length > 0) ||
        Boolean(c.body && /<(img|iframe|video|hr|table)\b/i.test(c.body));
      if (!h.title && !bodyHasContent) return null;
      const layout = c.layout === "split" || (c.layout !== "centered" && h.title) ? "split" : "centered";
      const prose = bodyHasContent ? (
        <div className={PROSE_CLASS} dangerouslySetInnerHTML={{ __html: sanitizeRichHtml(c.body!) }} />
      ) : null;
      if (layout === "split") {
        return (
          <PageSection presentation={p} anchor={c.anchor}>
            <div className="grid gap-y-8 lg:grid-cols-12 lg:gap-x-10">
              <div className="lg:col-span-4 lg:sticky lg:top-28 lg:self-start">
                {c.chapter && <p className="mb-4 font-serif text-5xl leading-none text-gold lg:text-6xl">{c.chapter}</p>}
                {h.eyebrow && <Eyebrow>{h.eyebrow}</Eyebrow>}
                <Title text={h.title} accent={c.accent} className={H_SECTION} />
              </div>
              <div className="lg:col-span-7 lg:col-start-6">
                <div className="max-w-[42rem]">{prose}</div>
              </div>
            </div>
          </PageSection>
        );
      }
      const alignClass = c.alignment === "center" ? "text-center" : c.alignment === "right" ? "text-right" : "text-left";
      return (
        <PageSection presentation={p} anchor={c.anchor}>
          <div className={cn("mx-auto w-full max-w-[46rem]", alignClass)}>
            {h.eyebrow && <Eyebrow className={c.alignment === "center" ? "justify-center" : ""}>{h.eyebrow}</Eyebrow>}
            {(h.title || c.accent) && <Title text={h.title} accent={c.accent} className={cn(H_SECTION, "mb-6")} />}
            {prose}
          </div>
        </PageSection>
      );
    }

    case "editorial":
      return <EditorialBlock b={b} ctx={ctx} />;

    case "quote": {
      if (!c.body) return null;
      const bg = ctx.pick(c.image);
      const tone = toneClass(p?.background);
      return (
        <section id={c.anchor || undefined} className={cn("relative w-full scroll-mt-28 overflow-hidden", tone)}>
          {bg && (
            <>
              <img src={bg.src} alt="" aria-hidden loading="lazy" decoding="async" className="absolute inset-0 h-full w-full object-cover opacity-45" />
              <div aria-hidden className="absolute inset-0 bg-gradient-to-b from-background/80 via-background/45 to-background/85" />
            </>
          )}
          <div className={cn(SECTION_CONTAINER, "relative py-20 sm:py-28 lg:py-32")}>
            <figure className="tk-fade-in-up mx-auto max-w-4xl text-center">
              {h.eyebrow && <Eyebrow className="justify-center">{h.eyebrow}</Eyebrow>}
              <span aria-hidden className="block font-serif text-7xl leading-[0.6] text-gold sm:text-8xl">&ldquo;</span>
              <blockquote className="mt-4 font-serif text-[1.7rem] italic leading-[1.28] text-foreground sm:text-4xl lg:text-[2.85rem]">
                {c.body}
              </blockquote>
              {c.attribution && (
                <figcaption className="mt-9 inline-flex items-center gap-3 font-body text-[0.68rem] uppercase tracking-[0.3em] text-gold">
                  <span aria-hidden className="h-px w-10 bg-gold/60" />
                  {c.attribution}
                  <span aria-hidden className="h-px w-10 bg-gold/60" />
                </figcaption>
              )}
            </figure>
          </div>
        </section>
      );
    }

    case "banner":
    case "cta_band":
      return <CtaBlock b={b} ctx={ctx} />;

    case "stats":
      return <StatsBlock b={b} ctx={ctx} />;

    case "timeline":
      return <TimelineBlock b={b} />;

    case "gallery": {
      const images = (c.images ?? []).map((im) => ctx.pick(im)).filter((x): x is PickedImage => Boolean(x));
      if (images.length === 0) return null;
      return (
        <PageSection presentation={p} anchor={c.anchor}>
          <HeadRow eyebrow={h.eyebrow} title={h.title} subtitle={h.subtitle} align={align} />
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 lg:grid-cols-4">
            {images.map((im, i) => (
              <MediaFrame key={i} image={im} aspect="aspect-square" rounded="rounded-2xl" />
            ))}
          </div>
        </PageSection>
      );
    }

    case "fifty_fifty": {
      const cards = (c.cards ?? []).filter((card) => card.title || card.body || card.image);
      if (cards.length === 0) return null;
      return (
        <PageSection presentation={p} anchor={c.anchor}>
          <HeadRow eyebrow={h.eyebrow} title={h.title} subtitle={h.subtitle} align={align} />
          <div className={cn("grid gap-4 lg:gap-6", colsFor(cards.length, 3))}>
            {cards.map((card, i) => {
              const image = ctx.pick(card.image, card.title);
              const inner = (
                <div className="card-luxury flex h-full flex-col bg-accent/30 p-6 sm:p-8">
                  {image && <MediaFrame image={image} aspect="aspect-[4/3]" rounded="rounded-xl" className="mb-5" />}
                  {card.eyebrow && <p className="mb-2 font-body text-[0.65rem] uppercase tracking-[0.28em] text-olive">{card.eyebrow}</p>}
                  {card.title && <h3 className="font-serif text-xl text-foreground sm:text-2xl">{card.title}</h3>}
                  {card.body && <p className="mt-2 font-body text-sm leading-relaxed text-muted-foreground">{card.body}</p>}
                </div>
              );
              return card.ctaHref ? (
                <SmartLink key={i} href={card.ctaHref} className="group block h-full">{inner}</SmartLink>
              ) : (
                <div key={i}>{inner}</div>
              );
            })}
          </div>
        </PageSection>
      );
    }

    case "feature_cards": {
      const cards = (c.cards ?? []).filter((card) => card.title || card.body);
      if (cards.length === 0) return null;
      return (
        <PageSection presentation={p} anchor={c.anchor}>
          <HeadRow eyebrow={h.eyebrow} title={h.title} subtitle={h.subtitle} align={align} />
          <div className={cn("grid gap-4 lg:gap-5", colsFor(cards.length, 4))}>
            {cards.map((card, i) => (
              // Each card is an inverted (onyx) surface — the local dark palette keeps its
              // eyebrow/meta gold and body copy at a readable contrast.
              <div key={i} className="tk-tone-dark ink-track relative flex h-full flex-col overflow-hidden rounded-[1.5rem] p-7 sm:p-8">
                <span aria-hidden className="font-serif text-sm tabular-nums text-gold">{nn(i)}</span>
                {card.eyebrow && <p className="mt-6 font-body text-[0.65rem] uppercase tracking-[0.28em] text-gold">{card.eyebrow}</p>}
                {card.title && <h3 className="mt-2 font-serif text-2xl leading-tight text-foreground">{card.title}</h3>}
                {card.body && <p className="mt-3 font-body text-sm leading-relaxed text-muted-foreground">{card.body}</p>}
                {card.meta && <p className="mt-auto pt-6 font-serif text-lg text-gold">{card.meta}</p>}
              </div>
            ))}
          </div>
        </PageSection>
      );
    }

    case "trust":
      return <TrustBlock b={b} />;

    case "steps":
      return <StepsBlock b={b} />;

    case "faq": {
      const faq = (c.faq ?? []).map((q) => ({ question: q.question, answer: q.answer }));
      if (faq.length === 0) return null;
      return (
        <PageSection presentation={p} anchor={c.anchor}>
          <div className="grid gap-y-8 lg:grid-cols-12 lg:gap-x-10">
            <div className="lg:col-span-4 lg:sticky lg:top-28 lg:self-start">
              <Eyebrow>{h.eyebrow || "FAQ"}</Eyebrow>
              <Title text={h.title || "Questions fréquentes"} className={H_SECTION} />
              {h.subtitle && <p className={cn(BODY, "mt-5")}>{h.subtitle}</p>}
            </div>
            <div className="lg:col-span-7 lg:col-start-6">
              <ProductFaqAccordion faqs={faq} />
            </div>
          </div>
        </PageSection>
      );
    }

    case "contact_channels":
      return <ContactChannelsBlock block={b} site={ctx.r.site} level={level} />;

    case "stores":
      return <StoresBlock b={b} ctx={ctx} />;

    case "jobs":
      return <JobsBlock b={b} ctx={ctx} />;

    case "product_grid": {
      const products = ctx.r.productsByBlock.get(b.id) ?? [];
      if (products.length === 0) return null;
      return (
        <PageSection presentation={p} anchor={c.anchor}>
          <HeadRow eyebrow={h.eyebrow} title={h.title} subtitle={h.subtitle} align={align} />
          <ProductGrid products={products} />
        </PageSection>
      );
    }

    case "categories":
      return renderRefCards(
        b,
        ctx,
        // The « Image boutique » (4:5 cover, as on /boutique + the home) is the real tile
        // image; the small chip iconMediaId is only a fallback.
        ctx.r.categories.map((x) => ({ slug: x.slug, name: x.name, mediaId: x.boutiqueImageMediaId ?? x.iconMediaId ?? null })),
        (s) => `/${s}`,
        "Catégories",
      );
    case "brands":
      return renderBrands(b, ctx);

    default:
      return null;
  }
}

// ── Hero ───────────────────────────────────────────────────────────────────────
function HeroBlock({ b, ctx, level }: { b: PageBlock; ctx: Ctx; level: 1 | 2 }) {
  const c = b.config;
  const p = c.presentation;
  const h = c.header ?? EMPTY_H;
  const layout = c.layout ?? "centered";
  const image = ctx.pick(c.image, h.title);
  const mobile = ctx.pick(c.imageMobile, h.title);
  // Include `accent` so an accent-only hero still renders (Title prints the accent as the
  // heading). isOpener() already counts accent, so without this the masthead is suppressed
  // but the hero returns null → the page would have ZERO h1 + a "coming soon" placeholder.
  if (!h.title && !c.accent && !c.body && !image) return null;
  const Tag = level === 1 ? "h1" : "h2";
  const priority = level === 1;
  const ctas = (
    <CtaPair
      primary={{ label: h.ctaLabel, href: h.ctaHref }}
      secondary={{ label: c.secondaryCtaLabel, href: c.secondaryCtaHref }}
    />
  );
  const chips = (c.chips ?? []).filter((x) => x.label);
  const pad = p?.padding && p.padding !== "default" ? undefined : "hero";

  if (layout === "statement") {
    return (
      <PageSection presentation={p} anchor={c.anchor} pad={pad} className="relative overflow-hidden">
        <div className="relative">
          <div className="relative grid gap-y-8 lg:grid-cols-12 lg:items-end lg:gap-x-10">
            <div className="tk-fade-in-up relative lg:col-span-8">
              {/* The founding year as a faint watermark BEHIND the title (never under the
                  lede/CTAs, where it would hurt legibility). */}
              {c.watermark && (
                <span
                  aria-hidden
                  className="pointer-events-none absolute -top-10 left-[30%] select-none font-serif text-[7.5rem] leading-none tracking-tighter text-foreground/[0.045] sm:-top-16 sm:text-[12rem] lg:-top-24 lg:left-[38%] lg:text-[15rem]"
                >
                  {c.watermark}
                </span>
              )}
              {h.eyebrow && <Eyebrow className="relative">{h.eyebrow}</Eyebrow>}
              <Title as={Tag} text={h.title} accent={c.accent} className={cn(H_DISPLAY, "relative")} />
            </div>
            <div className="lg:col-span-4 lg:pb-3">
              {h.subtitle && <p className="font-serif text-lg italic text-foreground/80 sm:text-xl">{h.subtitle}</p>}
              {c.body && <p className={cn(BODY, h.subtitle && "mt-3")}>{c.body}</p>}
              <div className="mt-7">{ctas}</div>
            </div>
          </div>
          {chips.length > 0 && (
            <nav aria-label="Sommaire" className="relative mt-12 border-t border-border/70 pt-5">
              <ol className="flex flex-wrap gap-x-8 gap-y-3">
                {chips.map((chip, i) => (
                  <li key={i}>
                    <SmartLink
                      href={chip.href}
                      className="group inline-flex items-baseline gap-2.5 font-body text-[0.7rem] uppercase tracking-[0.2em] text-muted-foreground transition-colors hover:text-foreground"
                    >
                      <span aria-hidden className="font-serif text-sm normal-case tracking-normal text-olive">{nn(i)}</span>
                      {chip.label}
                    </SmartLink>
                  </li>
                ))}
              </ol>
            </nav>
          )}
        </div>
        {image && (
          <MediaFrame
            image={image}
            mobile={mobile}
            fit={c.imageFit}
            priority={priority}
            aspect="aspect-[4/5] sm:aspect-[16/9] lg:aspect-[21/9]"
            className="mt-10 sm:mt-14"
          />
        )}
      </PageSection>
    );
  }

  if (layout === "split") {
    const portrait = image ? isPortrait(image) : false;
    return (
      <PageSection presentation={p} anchor={c.anchor} pad={pad}>
        <div className="grid items-center gap-y-10 lg:grid-cols-12 lg:gap-x-12">
          <div className={cn("tk-fade-in-up", image ? "lg:col-span-6" : "lg:col-span-8")}>
            {h.eyebrow && <Eyebrow>{h.eyebrow}</Eyebrow>}
            <Title as={Tag} text={h.title} accent={c.accent} className={H_PAGE} />
            {h.subtitle && <p className="mt-5 font-serif text-lg italic text-foreground/80 sm:text-xl">{h.subtitle}</p>}
            {c.body && <p className={cn(BODY, "mt-5 max-w-xl")}>{c.body}</p>}
            {chips.length > 0 && (
              <ul className="mt-7 flex flex-wrap gap-2">
                {chips.map((chip, i) => (
                  <li key={i}>
                    <SmartLink
                      href={chip.href}
                      className="inline-flex items-center gap-2 rounded-full border border-border/80 bg-card/60 px-3.5 py-1.5 font-body text-[0.72rem] tracking-wide text-foreground/85"
                    >
                      <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-olive" />
                      {chip.label}
                    </SmartLink>
                  </li>
                ))}
              </ul>
            )}
            <div className="mt-8">{ctas}</div>
          </div>
          {image && (
            <div className={portrait ? "lg:col-span-5 lg:col-start-8" : "lg:col-span-6"}>
              <MediaFrame
                image={image}
                mobile={mobile}
                fit={c.imageFit}
                priority={priority}
                aspect={portrait ? "aspect-[4/5]" : "aspect-[4/3]"}
              />
            </div>
          )}
        </div>
      </PageSection>
    );
  }

  if (layout === "compact") {
    return (
      <PageSection presentation={p} anchor={c.anchor} pad={pad}>
        <div className="grid gap-y-8 lg:grid-cols-12 lg:items-end lg:gap-x-10">
          <div className="tk-fade-in-up lg:col-span-7">
            {h.eyebrow && <Eyebrow>{h.eyebrow}</Eyebrow>}
            <Title as={Tag} text={h.title} accent={c.accent} className={H_DISPLAY} />
          </div>
          <div className="lg:col-span-5 lg:pb-3">
            {h.subtitle && <p className="font-serif text-lg italic text-foreground/80 sm:text-xl">{h.subtitle}</p>}
            {c.body && <p className={cn(BODY, h.subtitle && "mt-3")}>{c.body}</p>}
            {chips.length > 0 && (
              <ul className="mt-6 flex flex-wrap gap-x-6 gap-y-2">
                {chips.map((chip, i) => (
                  <li key={i}>
                    <SmartLink
                      href={chip.href}
                      className="inline-flex items-center gap-2 font-body text-[0.7rem] uppercase tracking-[0.2em] text-foreground/80 transition-colors hover:text-olive"
                    >
                      <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-gold" />
                      {chip.label}
                    </SmartLink>
                  </li>
                ))}
              </ul>
            )}
            <div className="mt-7">{ctas}</div>
          </div>
        </div>
        {image && (
          <MediaFrame image={image} mobile={mobile} fit={c.imageFit} priority={priority} aspect="aspect-[16/9] lg:aspect-[21/9]" className="mt-12" />
        )}
      </PageSection>
    );
  }

  // centered (classic): copy first, CTAs above the fold, the image (if any) full width below.
  return (
    <PageSection presentation={p} anchor={c.anchor} pad={pad}>
      <div className="tk-fade-in-up mx-auto max-w-4xl text-center">
        {h.eyebrow && <Eyebrow className="justify-center">{h.eyebrow}</Eyebrow>}
        <Title as={Tag} text={h.title} accent={c.accent} className={H_PAGE} />
        {h.subtitle && <p className="mt-4 font-serif text-lg italic text-foreground/75 sm:text-xl">{h.subtitle}</p>}
        {c.body && <p className={cn(BODY, "mx-auto mt-5 max-w-2xl")}>{c.body}</p>}
        <CtaPair
          className="mt-8 justify-center"
          primary={{ label: h.ctaLabel, href: h.ctaHref }}
          secondary={{ label: c.secondaryCtaLabel, href: c.secondaryCtaHref }}
        />
      </div>
      {image && (
        <MediaFrame image={image} mobile={mobile} fit={c.imageFit} priority={priority} aspect="aspect-[4/3] sm:aspect-[16/9] lg:aspect-[21/9]" className="mt-12" />
      )}
    </PageSection>
  );
}

// ── Editorial ──────────────────────────────────────────────────────────────────
function EditorialBlock({ b, ctx }: { b: PageBlock; ctx: Ctx }) {
  const c = b.config;
  const h = c.header ?? EMPTY_H;
  const image = ctx.pick(c.image, h.title);
  const mobile = ctx.pick(c.imageMobile, h.title);
  const points = c.points ?? [];
  if (!h.title && !c.body && !image) return null;
  const left = c.imageSide === "left";
  const portrait = isPortrait(image);
  // Portrait photo → 5/12 media + 6/12 text; landscape/packshot → 7/12 media + 5/12 text.
  const mediaCls = portrait
    ? left ? "lg:col-span-5 lg:col-start-1" : "lg:col-span-5 lg:col-start-8"
    : left ? "lg:col-span-7 lg:col-start-1" : "lg:col-span-7 lg:col-start-6";
  const textCls = portrait
    ? left ? "lg:col-span-6 lg:col-start-7" : "lg:col-span-6 lg:col-start-1"
    : left ? "lg:col-span-5 lg:col-start-8" : "lg:col-span-5 lg:col-start-1";
  return (
    <PageSection presentation={c.presentation} anchor={c.anchor}>
      <div className="grid items-center gap-y-10 lg:grid-cols-12 lg:gap-x-10">
        <div className={cn(mediaCls, "lg:row-start-1")}>
          {image ? (
            <MediaFrame image={image} mobile={mobile} fit={c.imageFit} aspect={portrait ? "aspect-[4/5]" : "aspect-[4/3]"} />
          ) : (
            <div className="tk-vitrine aspect-[4/3] w-full rounded-[1.75rem]" />
          )}
        </div>
        <div className={cn(textCls, "lg:row-start-1")}>
          {c.chapter && <p className="mb-4 font-serif text-5xl leading-none text-gold">{c.chapter}</p>}
          {h.eyebrow && <Eyebrow>{h.eyebrow}</Eyebrow>}
          <Title text={h.title} accent={c.accent} className={H_SECTION} />
          <div className="luxury-divider mt-6 max-w-[80px]" />
          {c.body && <p className={cn(BODY, "mt-6")}>{c.body}</p>}
          {points.length > 0 && (
            <ol className="mt-8 divide-y divide-border/60 border-y border-border/60">
              {points.map((pt, i) => (
                <li key={i} className="grid grid-cols-[2.5rem_1fr] gap-x-3 py-4">
                  <span aria-hidden className="font-serif text-lg tabular-nums text-olive">{nn(i)}</span>
                  <span>
                    {pt.title && <span className="block font-serif text-lg text-foreground">{pt.title}</span>}
                    {pt.body && <span className="mt-1 block font-body text-sm leading-relaxed text-muted-foreground">{pt.body}</span>}
                  </span>
                </li>
              ))}
            </ol>
          )}
          <CtaPair className="mt-8" primary={{ label: h.ctaLabel, href: h.ctaHref }} primaryVariant="secondary" />
        </div>
      </div>
    </PageSection>
  );
}

// ── CTA band / banner ──────────────────────────────────────────────────────────
function CtaBlock({ b, ctx }: { b: PageBlock; ctx: Ctx }) {
  const c = b.config;
  const p = c.presentation;
  const h = c.header ?? EMPTY_H;
  const align = p?.align ?? "left";
  const image = ctx.pick(c.image, h.title);
  const mobile = ctx.pick(c.imageMobile, h.title);
  if (!image && !h.title) return null;
  const primary = { label: h.ctaLabel, href: h.ctaHref };
  const secondary = { label: c.secondaryCtaLabel, href: c.secondaryCtaHref };

  if (image) {
    // Image banner — real buttons on top of a plain frame (never a link nested in a
    // link). When a link is set but NO button label, the whole frame is the link instead.
    const primaryBtn = Boolean(primary.label && realHref(primary.href));
    const secondaryBtn = Boolean(secondary.label && realHref(secondary.href));
    const frameHref = !primaryBtn && !secondaryBtn ? realHref(h.ctaHref) : "";
    const frameCls = "relative flex min-h-[20rem] items-end overflow-hidden rounded-[1.75rem] md:aspect-[21/9] md:min-h-0";
    const inner = (
      <>
          <picture>
            {mobile && <source media="(max-width: 640px)" srcSet={mobile.src} />}
            <img src={image.src} alt={image.alt} loading="lazy" decoding="async" className="absolute inset-0 h-full w-full object-cover" />
          </picture>
          <div aria-hidden className="absolute inset-0 bg-gradient-to-t from-black/70 via-black/20 to-transparent" />
          <div className={cn("relative z-10 max-w-2xl p-8 md:p-12", align === "center" && "mx-auto text-center")}>
            {h.eyebrow && <p className="mb-3 font-body text-[0.65rem] uppercase tracking-[0.3em] text-white/80">{h.eyebrow}</p>}
            {h.title && (
              <h2 className="font-serif text-3xl font-normal leading-tight tracking-tight text-white md:text-4xl">
                {h.title}
                {c.accent && <span className="block italic text-[hsl(30_40%_80%)]">{c.accent}</span>}
              </h2>
            )}
            {h.subtitle && <p className="mt-3 font-body text-sm text-white/85 md:text-base">{h.subtitle}</p>}
            {(primaryBtn || secondaryBtn) && (
              <div className={cn("mt-6 flex flex-wrap gap-3", align === "center" && "justify-center")}>
                {primaryBtn && (
                  <SmartLink href={primary.href} className={buttonVariants({ variant: "primary", size: "md", onDark: true })}>
                    <span className="btn__label">{primary.label}</span>
                  </SmartLink>
                )}
                {secondaryBtn && (
                  <SmartLink href={secondary.href!} className={buttonVariants({ variant: "secondary", size: "md", onDark: true })}>
                    <span className="btn__label">{secondary.label}</span>
                  </SmartLink>
                )}
              </div>
            )}
          </div>
      </>
    );
    return (
      <PageSection presentation={p} anchor={c.anchor}>
        {frameHref ? (
          // Guarantee an accessible name: the title if present, else the visible eyebrow/subtitle
          // name the link, else the image alt, else a neutral label — never an unnamed frame-link.
          <SmartLink
            href={frameHref}
            aria-label={h.title || (h.eyebrow || h.subtitle ? undefined : image.alt || "Découvrir")}
            className={cn("group", frameCls)}
          >
            {inner}
          </SmartLink>
        ) : (
          <div className={frameCls}>{inner}</div>
        )}
      </PageSection>
    );
  }

  // No image → a compact BAR (not an empty 21:9 slab): title left, buttons right, on a
  // locally re-toned panel so every token (text, gold accent, buttons) adapts.
  const tone = c.style === "brand" ? "tk-tone-brand" : c.style === "light" ? "tk-tone-surface" : "tk-tone-dark";
  return (
    <PageSection presentation={p} anchor={c.anchor}>
      <div className={cn(tone, "relative overflow-hidden rounded-[1.75rem] px-6 py-10 sm:px-10 md:px-14 md:py-14")}>
        {align === "center" ? (
          <div className="relative mx-auto max-w-2xl text-center">
            {h.eyebrow && <Eyebrow className="justify-center">{h.eyebrow}</Eyebrow>}
            <Title text={h.title} accent={c.accent} className="text-3xl leading-[1.1] md:text-4xl" />
            {h.subtitle && <p className={cn(BODY, "mx-auto mt-4 max-w-xl")}>{h.subtitle}</p>}
            <CtaPair className="mt-8 justify-center" primary={primary} secondary={secondary} />
          </div>
        ) : (
          <div className="relative grid gap-8 lg:grid-cols-12 lg:items-center lg:gap-x-10">
            <div className="lg:col-span-7">
              {h.eyebrow && <Eyebrow>{h.eyebrow}</Eyebrow>}
              <Title text={h.title} accent={c.accent} className="text-3xl leading-[1.1] md:text-4xl" />
              {h.subtitle && <p className={cn(BODY, "mt-4 max-w-xl")}>{h.subtitle}</p>}
            </div>
            <CtaPair className="lg:col-span-5 lg:justify-end" primary={primary} secondary={secondary} />
          </div>
        )}
      </div>
    </PageSection>
  );
}

// ── Stats ──────────────────────────────────────────────────────────────────────
function StatsBlock({ b, ctx }: { b: PageBlock; ctx: Ctx }) {
  const c = b.config;
  const p = c.presentation;
  const h = c.header ?? EMPTY_H;
  const items = (c.stats ?? [])
    .map((s) => {
      // Live sources fall back to the operator's value when the data is unavailable.
      const live =
        s.source === "brands" && ctx.r.brandCount != null && ctx.r.brandCount > 0
          ? String(ctx.r.brandCount)
          : s.source === "years_since"
            ? yearsSinceLabel(s.since, ctx.now)
            : null;
      return { ...s, value: live ?? s.value };
    })
    .filter((s) => (s.source === "manual" ? s.value || s.label : s.value));
  if (items.length === 0) return null;
  const layout = c.layout ?? "grid";
  const head = <HeadRow eyebrow={h.eyebrow} title={h.title} subtitle={h.subtitle} align={p?.align ?? "left"} />;
  const value = "font-serif leading-none tracking-tight text-foreground tabular-nums text-balance";

  if (layout === "ledger") {
    return (
      <PageSection presentation={p} anchor={c.anchor}>
        {head}
        <div className={cn("grid grid-cols-2 border-y border-border/70", items.length >= 4 ? "lg:grid-cols-4" : items.length === 3 ? "lg:grid-cols-3" : "")}>
          {items.map((it, i) => (
            <div
              key={i}
              className={cn(
                "flex flex-col px-3 py-8 sm:px-6 lg:py-10",
                i % 2 === 1 && "border-l border-border/70",
                i >= 2 && "border-t border-border/70 lg:border-t-0",
                i > 0 && "lg:border-l lg:border-border/70",
              )}
            >
              <p className={cn(value, "text-[clamp(2.1rem,6vw,3.75rem)]")}>{it.value}</p>
              <p className="mt-4 font-body text-[0.68rem] uppercase tracking-[0.24em] text-olive">{it.label}</p>
              {it.caption && <p className="mt-2 font-body text-sm leading-relaxed text-muted-foreground">{it.caption}</p>}
            </div>
          ))}
        </div>
      </PageSection>
    );
  }

  const isRow = layout === "row";
  return (
    <PageSection presentation={p} anchor={c.anchor}>
      {head}
      <div className={isRow ? "flex flex-wrap gap-4" : cn("grid gap-4", items.length === 4 ? "grid-cols-2 lg:grid-cols-4" : colsFor(items.length, 4))}>
        {items.map((it, i) => (
          <div
            key={i}
            className={cn("relative rounded-[1.5rem] border border-border/60 bg-card/60 px-5 py-7 text-center sm:px-6", isRow && "min-w-[11rem] flex-1")}
          >
            <span aria-hidden className="absolute inset-x-8 top-0 h-px bg-gradient-to-r from-transparent via-gold/60 to-transparent" />
            <p className={cn(value, "text-[clamp(1.6rem,4.5vw,2.6rem)] break-words")}>{it.value}</p>
            <p className="mt-3 font-body text-[0.65rem] uppercase tracking-[0.22em] text-olive">{it.label}</p>
            {it.caption && <p className="mt-2 font-body text-xs leading-relaxed text-muted-foreground">{it.caption}</p>}
          </div>
        ))}
      </div>
    </PageSection>
  );
}

// ── Timeline ───────────────────────────────────────────────────────────────────
function TimelineBlock({ b }: { b: PageBlock }) {
  const c = b.config;
  const p = c.presentation;
  const h = c.header ?? EMPTY_H;
  const items = (c.timeline ?? []).filter((t) => t.year || t.title);
  if (items.length === 0) return null;

  if (c.layout === "rail") {
    const lgCols = items.length <= 2 ? "lg:grid-cols-2" : items.length === 3 ? "lg:grid-cols-3" : items.length === 5 ? "lg:grid-cols-5" : "lg:grid-cols-4";
    return (
      <PageSection presentation={p} anchor={c.anchor}>
        <HeadRow eyebrow={h.eyebrow} title={h.title} chapter={c.chapter} align={p?.align ?? "left"} />
        <div className="relative">
        <span aria-hidden className="absolute inset-x-0 top-[0.4rem] hidden h-px bg-gradient-to-r from-gold/60 via-gold/40 to-gold/10 lg:block" />
        <ol className={cn("relative ml-1.5 grid gap-y-10 border-l border-gold/40 lg:ml-0 lg:gap-x-8 lg:border-l-0", lgCols)}>
          {items.map((it, i) => (
            <li key={i} className="relative pl-8 lg:pl-0 lg:pt-12">
              <span aria-hidden className="absolute -left-[0.45rem] top-2 h-3.5 w-3.5 rounded-full border-2 border-gold bg-background lg:left-0 lg:top-0" />
              <p className="font-serif text-4xl leading-none tracking-tight text-gold lg:text-5xl">{it.year}</p>
              {it.title && <h3 className="mt-4 font-serif text-xl text-foreground">{it.title}</h3>}
              {it.description && <p className="mt-2 font-body text-sm leading-relaxed text-muted-foreground">{it.description}</p>}
            </li>
          ))}
        </ol>
        </div>
      </PageSection>
    );
  }

  return (
    <PageSection presentation={p} anchor={c.anchor}>
      <div className="grid gap-y-10 lg:grid-cols-12 lg:gap-x-10">
        <div className="lg:col-span-4 lg:sticky lg:top-28 lg:self-start">
          {c.chapter && <p className="mb-4 font-serif text-5xl leading-none text-gold lg:text-6xl">{c.chapter}</p>}
          {h.eyebrow && <Eyebrow>{h.eyebrow}</Eyebrow>}
          <Title text={h.title} className={H_SECTION} />
        </div>
        <ol className="relative ml-1.5 space-y-10 border-l border-gold/40 pl-8 lg:col-span-7 lg:col-start-6">
          {items.map((it, i) => (
            <li key={i} className="relative">
              <span aria-hidden className="absolute -left-[2.45rem] top-2 h-3.5 w-3.5 rounded-full border-2 border-gold bg-background" />
              <p className="font-serif text-3xl leading-none text-gold">{it.year}</p>
              {it.title && <h3 className="mt-3 font-serif text-xl text-foreground">{it.title}</h3>}
              {it.description && <p className="mt-2 font-body text-sm leading-relaxed text-muted-foreground">{it.description}</p>}
            </li>
          ))}
        </ol>
      </div>
    </PageSection>
  );
}

// ── Trust / tiles / values ─────────────────────────────────────────────────────
function TrustBlock({ b }: { b: PageBlock }) {
  const c = b.config;
  const p = c.presentation;
  const h = c.header ?? EMPTY_H;
  const cards = (c.cards ?? []).filter((card) => card.title || card.body);
  if (cards.length === 0) return null;
  const layout = c.layout ?? "cards";
  const head = <HeadRow eyebrow={h.eyebrow} title={h.title} subtitle={h.subtitle} chapter={c.chapter} align={p?.align ?? "left"} />;

  if (layout === "tiles") {
    return (
      <PageSection presentation={p} anchor={c.anchor}>
        {head}
        <ul className={cn("grid gap-4", colsFor(cards.length, 3))}>
          {cards.map((card, i) => {
            const Icon = valuePropIcon(card.icon);
            const body = (
              <>
                <span className="grid h-11 w-11 place-items-center rounded-full bg-accent/50 text-olive">
                  <Icon className="h-5 w-5" strokeWidth={1.5} aria-hidden />
                </span>
                <h3 className="mt-6 font-serif text-xl tracking-tight text-foreground">{card.title}</h3>
                {card.body && <p className="mt-2 font-body text-sm leading-relaxed text-muted-foreground">{card.body}</p>}
                {card.ctaHref && (
                  <span className="mt-auto inline-flex items-center gap-2 pt-6 font-body text-[0.68rem] uppercase tracking-[0.2em] text-foreground">
                    {card.ctaLabel || "Accéder"}
                    <ArrowRight className="h-3.5 w-3.5 text-olive transition-[translate] duration-300 group-hover:translate-x-1" aria-hidden />
                  </span>
                )}
              </>
            );
            const cls =
              "flex h-full flex-col rounded-[1.5rem] border border-border/60 bg-card/70 p-6 sm:p-7 transition-[translate,border-color,background-color,box-shadow] duration-500";
            return (
              <li key={i}>
                {card.ctaHref ? (
                  <SmartLink
                    href={card.ctaHref}
                    className={cn(cls, "group hover:-translate-y-0.5 hover:border-olive/40 hover:bg-card hover:shadow-[0_22px_44px_-30px_rgba(43,40,37,0.45)]")}
                  >
                    {body}
                  </SmartLink>
                ) : (
                  <div className={cls}>{body}</div>
                )}
              </li>
            );
          })}
        </ul>
      </PageSection>
    );
  }

  if (layout === "numbered") {
    return (
      <PageSection presentation={p} anchor={c.anchor}>
        {head}
        <ol className={cn("grid border-t border-border/70", colsFor(cards.length, 4))}>
          {cards.map((card, i) => (
            <li key={i} className={cn("border-b border-border/70 py-8 lg:py-10", numberedCell(i, cards.length))}>
              <p aria-hidden className="font-serif text-5xl leading-none text-gold">{nn(i)}</p>
              <h3 className="mt-6 font-serif text-2xl tracking-tight text-foreground">{card.title}</h3>
              {card.body && <p className="mt-3 font-body text-sm leading-relaxed text-muted-foreground">{card.body}</p>}
            </li>
          ))}
        </ol>
      </PageSection>
    );
  }

  const plain = layout === "plain";
  return (
    <PageSection presentation={p} anchor={c.anchor}>
      {head}
      <div className={cn("grid", plain ? "gap-x-10 gap-y-12" : "gap-4", colsFor(cards.length, 4))}>
        {cards.map((card, i) => {
          const Icon = valuePropIcon(card.icon);
          return (
            <div key={i} className={plain ? "" : "flex h-full flex-col rounded-[1.5rem] border border-border/60 bg-card/60 p-6 sm:p-7"}>
              <span
                className={
                  plain
                    ? "grid h-12 w-12 place-items-center rounded-full ring-1 ring-gold/45 text-gold"
                    : "grid h-11 w-11 place-items-center rounded-full bg-accent/50 text-olive"
                }
              >
                <Icon className="h-5 w-5" strokeWidth={1.5} aria-hidden />
              </span>
              {card.title && <h3 className="mt-6 font-serif text-xl tracking-tight text-foreground">{card.title}</h3>}
              {card.body && <p className="mt-2 font-body text-sm leading-relaxed text-muted-foreground">{card.body}</p>}
            </div>
          );
        })}
      </div>
    </PageSection>
  );
}

/** Gutters + vertical rules for the « numbered » values grid at every breakpoint:
 *  1 col (mobile) → none; 2 cols (sm, 4 items) / 3 cols (md) / 4 cols (lg) → a rule +
 *  left gutter on every cell that is not first in its row, none on the row starters. */
function numberedCell(i: number, n: number): string {
  if (n === 2) return i === 0 ? "sm:pr-6" : "sm:border-l sm:pl-6";
  if (n === 3) return i === 0 ? "md:pr-6" : "md:border-l md:px-6";
  if (n === 4)
    return cn(
      i % 2 === 0 ? "sm:max-lg:pr-6" : "sm:max-lg:border-l sm:max-lg:pl-6",
      "lg:border-b-0",
      i === 0 ? "lg:pr-6" : "lg:border-l lg:px-6",
    );
  return "";
}

// ── Steps ──────────────────────────────────────────────────────────────────────
function StepsBlock({ b }: { b: PageBlock }) {
  const c = b.config;
  const p = c.presentation;
  const h = c.header ?? EMPTY_H;
  const steps = (c.steps ?? []).filter((s) => s.title || s.body);
  if (steps.length === 0) return null;
  const layout = c.layout ?? "cards";
  const meta = (m: string) =>
    m ? (
      <span className="inline-flex rounded-full border border-border/80 px-3 py-1 font-body text-[0.7rem] uppercase tracking-[0.14em] text-foreground/80">
        {m}
      </span>
    ) : null;

  if (layout === "vertical") {
    return (
      <PageSection presentation={p} anchor={c.anchor}>
        <div className="grid gap-y-10 lg:grid-cols-12 lg:gap-x-10">
          <div className="lg:col-span-4 lg:sticky lg:top-28 lg:self-start">
            {h.eyebrow && <Eyebrow>{h.eyebrow}</Eyebrow>}
            <Title text={h.title} accent={c.accent} className={H_SECTION} />
            {h.subtitle && <p className={cn(BODY, "mt-5")}>{h.subtitle}</p>}
            <CtaPair className="mt-7" primary={{ label: h.ctaLabel, href: h.ctaHref }} primaryVariant="secondary" />
          </div>
          <ol className="lg:col-span-7 lg:col-start-6">
            {steps.map((s, i) => (
              <li key={i} className="relative grid grid-cols-[3rem_1fr] gap-x-5 pb-10 last:pb-0">
                <div className="relative flex flex-col items-center">
                  <span className="relative z-10 grid h-12 w-12 place-items-center rounded-full border border-gold/60 bg-background font-serif text-lg text-gold">
                    {nn(i)}
                  </span>
                  {i < steps.length - 1 && <span aria-hidden className="mt-2 w-px flex-1 bg-gradient-to-b from-gold/50 to-border/40" />}
                </div>
                <div className="pt-2.5">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                    <h3 className="font-serif text-xl tracking-tight text-foreground sm:text-2xl">{s.title}</h3>
                    {meta(s.meta)}
                  </div>
                  {s.body && <p className={cn(BODY, "mt-2")}>{s.body}</p>}
                </div>
              </li>
            ))}
          </ol>
        </div>
      </PageSection>
    );
  }

  if (layout === "ladder") {
    return (
      <PageSection presentation={p} anchor={c.anchor}>
        <HeadRow eyebrow={h.eyebrow} title={h.title} accent={c.accent} subtitle={h.subtitle} align={p?.align ?? "left"} />
        <div className="relative">
        <span aria-hidden className="absolute inset-x-6 top-6 hidden h-px bg-gradient-to-r from-gold/50 via-gold/30 to-gold/10 lg:block" />
        <ol className={cn("relative grid gap-y-10 lg:gap-x-8", colsFor(steps.length, 5))}>
          {steps.map((s, i) => (
            <li key={i} className="relative">
              <span aria-hidden className="pointer-events-none absolute -top-3 right-0 select-none font-serif text-[5.5rem] leading-none text-foreground/[0.05]">
                {nn(i)}
              </span>
              <span className="relative z-10 grid h-12 w-12 place-items-center rounded-full border border-gold/60 bg-background font-serif text-lg text-gold">
                {nn(i)}
              </span>
              <h3 className="mt-6 font-serif text-xl tracking-tight text-foreground">{s.title}</h3>
              {s.body && <p className="mt-2 font-body text-sm leading-relaxed text-muted-foreground">{s.body}</p>}
              {s.meta && <div className="mt-4">{meta(s.meta)}</div>}
            </li>
          ))}
        </ol>
        </div>
      </PageSection>
    );
  }

  return (
    <PageSection presentation={p} anchor={c.anchor}>
      <HeadRow eyebrow={h.eyebrow} title={h.title} accent={c.accent} subtitle={h.subtitle} align={p?.align ?? "left"} />
      <ol className={cn("grid gap-4", colsFor(steps.length, 5))}>
        {steps.map((s, i) => (
          <li key={i} className="flex h-full flex-col rounded-[1.5rem] border border-border/60 bg-card/60 p-6">
            <span className="font-serif text-3xl text-olive">{nn(i)}</span>
            {s.title && <h3 className="mt-4 font-serif text-lg tracking-tight text-foreground">{s.title}</h3>}
            {s.body && <p className="mt-2 font-body text-sm leading-relaxed text-muted-foreground">{s.body}</p>}
            {s.meta && <div className="mt-auto pt-4">{meta(s.meta)}</div>}
          </li>
        ))}
      </ol>
    </PageSection>
  );
}

// ── Stores ─────────────────────────────────────────────────────────────────────
function StoresBlock({ b, ctx }: { b: PageBlock; ctx: Ctx }) {
  const c = b.config;
  const p = c.presentation;
  const h = c.header ?? EMPTY_H;
  const site = ctx.r.site;
  const stores: AtlasStore[] = (c.stores ?? [])
    .map((s) => {
      // A store linked to a pickup location takes its LIVE values (one source of truth
      // with « Retrait en boutique »); the card's own copy is the fallback.
      const pk = s.pickupLocationId ? ctx.r.pickups.get(s.pickupLocationId) : undefined;
      const name = pk?.name || s.name;
      const address = pk?.address || s.address;
      const city = pk?.city || s.city;
      const phone = pk?.phone || s.phone || site.phone;
      const hours = pk?.hours
        ? [{ label: "Horaires", value: pk.hours }]
        : s.hours.length
          ? s.hours
          : site.hours
            ? [{ label: "Horaires", value: site.hours }]
            : [];
      const urls = mapUrlsFor(address, city);
      const img = ctx.pick(s.image, name);
      return {
        name,
        badge: s.badge,
        address,
        city,
        phone,
        phoneHref: telHref(phone),
        email: s.email,
        hours,
        services: s.services,
        note: s.note,
        embed: s.mapEmbedUrl || urls?.embed || "",
        directions: urls?.directions ?? "",
        image: img ? { src: img.src, alt: img.alt } : null,
      };
    })
    .filter((s) => s.name || s.address);
  if (stores.length === 0) return null;

  if (c.layout === "salons") {
    return (
      <PageSection presentation={p} anchor={c.anchor}>
        <HeadRow eyebrow={h.eyebrow} title={h.title} accent={c.accent} subtitle={h.subtitle} />
        <div className="space-y-6">
          {stores.map((s, i) => (
            <div key={i} className="grid gap-y-6 rounded-[1.75rem] border border-border/60 bg-card/60 p-4 sm:p-6 lg:grid-cols-12 lg:items-center lg:gap-x-10">
              <div className={cn("lg:col-span-7", i % 2 === 1 && "lg:order-last")}>
                {s.image ? (
                  <img src={s.image.src} alt={s.image.alt} loading="lazy" decoding="async" className="aspect-[4/3] w-full rounded-[1.25rem] object-cover" />
                ) : c.showMap !== false && s.embed ? (
                  <iframe src={s.embed} title={`Carte — ${s.name}`} loading="lazy" referrerPolicy="no-referrer-when-downgrade" className="aspect-[4/3] w-full rounded-[1.25rem] border-0 grayscale-[30%]" />
                ) : null}
              </div>
              <div className="px-2 pb-2 lg:col-span-5">
                {/* The photo is shown beside — the card itself carries no image. */}
                <StoreAtlas stores={[{ ...s, image: null }]} showMap={false} indexOffset={i} total={stores.length} />
              </div>
            </div>
          ))}
        </div>
      </PageSection>
    );
  }

  return (
    <PageSection presentation={p} anchor={c.anchor}>
      <HeadRow
        eyebrow={h.eyebrow}
        title={h.title}
        accent={c.accent}
        subtitle={h.subtitle}
        aside={
          <p className="font-body text-[0.68rem] uppercase tracking-[0.24em] text-muted-foreground">
            {stores.length} adresse{stores.length > 1 ? "s" : ""}
          </p>
        }
      />
      <StoreAtlas stores={stores} showMap={c.showMap !== false} />
    </PageSection>
  );
}

// ── Jobs ───────────────────────────────────────────────────────────────────────
function JobsBlock({ b, ctx }: { b: PageBlock; ctx: Ctx }) {
  const c = b.config;
  const p = c.presentation;
  const h = c.header ?? EMPTY_H;
  const email = c.applyEmail || ctx.r.site.email;
  const mailto = (subject: string) => (email ? `mailto:${email}?subject=${encodeURIComponent(subject)}` : "");
  const jobs: BoardJob[] = (c.jobs ?? [])
    .filter((j) => j.active && j.title)
    .map((j) => ({
      title: j.title,
      team: j.team,
      location: j.location,
      contract: j.contract,
      summary: j.summary,
      missions: j.missions,
      profile: j.profile,
      // A per-job link (external posting / form / mailto) wins; else the block's e-mail.
      applyHref: realHref(safeHref(j.applyHref)) || mailto(`Candidature — ${j.title}`),
    }));
  return (
    <PageSection presentation={p} anchor={c.anchor}>
      <HeadRow
        eyebrow={h.eyebrow}
        title={h.title}
        accent={c.accent}
        subtitle={h.subtitle}
        aside={
          jobs.length > 0 ? (
            <p className="inline-flex items-baseline gap-2 font-body text-[0.68rem] uppercase tracking-[0.24em] text-muted-foreground">
              <span className="font-serif text-3xl normal-case tracking-normal text-gold">{jobs.length}</span>
              poste{jobs.length > 1 ? "s" : ""} ouvert{jobs.length > 1 ? "s" : ""}
            </p>
          ) : null
        }
      />
      <JobBoard
        jobs={jobs}
        emptyText={c.emptyText ?? ""}
        spontaneousHref={c.spontaneousEnabled === false ? "" : mailto(c.spontaneousTitle || "Candidature spontanée")}
        spontaneous={{ title: c.spontaneousTitle ?? "", body: c.spontaneousBody ?? "", ctaLabel: c.spontaneousCtaLabel ?? "" }}
      />
    </PageSection>
  );
}

// ── Catalogue blocks ───────────────────────────────────────────────────────────
function renderRefCards(
  b: PageBlock,
  ctx: Ctx,
  all: { slug: string; name: string; mediaId: string | null }[],
  href: (slug: string) => string,
  fallbackTitle: string,
): React.ReactNode {
  const c = b.config;
  const h = c.header ?? EMPTY_H;
  const refs = c.refs ?? [];
  let list = refs.length > 0 ? (refs.map((s) => all.find((x) => x.slug === s)).filter(Boolean) as typeof all) : all;
  list = list.slice(0, c.count ?? 8);
  if (list.length === 0) return null;
  return (
    <PageSection presentation={c.presentation} anchor={c.anchor}>
      <HeadRow eyebrow={h.eyebrow} title={h.title || fallbackTitle} subtitle={h.subtitle} align={c.presentation?.align} />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 lg:grid-cols-4">
        {list.map((it) => {
          const image = ctx.pick(it.mediaId ? { mediaId: it.mediaId, alt: "" } : null, it.name);
          return (
            <Link
              key={it.slug}
              href={href(it.slug)}
              className="group relative flex aspect-[4/5] flex-col justify-end overflow-hidden rounded-[1.5rem] border border-border/40 transition-[translate,border-color] duration-500 hover:-translate-y-1 hover:border-primary/30"
            >
              {image ? (
                <Image src={image.src} alt={image.alt} fill sizes="(max-width:640px) 50vw, 25vw" className="object-cover transition-transform duration-700 group-hover:scale-[1.05]" />
              ) : (
                <div className="absolute inset-0 bg-gradient-to-br from-surface via-card to-muted/40" />
              )}
              <div className="absolute inset-0 bg-gradient-to-t from-black/65 via-black/10 to-transparent" />
              <h3 className="relative z-10 truncate p-4 font-serif text-base tracking-tight text-white sm:text-lg">{it.name}</h3>
            </Link>
          );
        })}
      </div>
    </PageSection>
  );
}

function renderBrands(b: PageBlock, ctx: Ctx): React.ReactNode {
  const c = b.config;
  const h = c.header ?? EMPTY_H;
  const refs = c.refs ?? [];
  const all = ctx.r.brands;
  let list = refs.length > 0 ? (refs.map((s) => all.find((x) => x.slug === s)).filter(Boolean) as typeof all) : all;
  list = list.slice(0, c.count ?? 12);
  if (list.length === 0) return null;
  return (
    <PageSection presentation={c.presentation} anchor={c.anchor}>
      <HeadRow
        eyebrow={h.eyebrow}
        title={h.title || "Marques"}
        subtitle={h.subtitle}
        align={c.presentation?.align}
        aside={
          // Operator-editable « voir tout » — label + target from the header, else the default.
          <Link href={realHref(safeHref(h.ctaHref)) || "/marques"} className={buttonVariants({ variant: "link", size: "sm" })}>
            <span className="btn__label">
              {h.ctaLabel || "Toutes les marques"} <ArrowRight className="h-3.5 w-3.5" aria-hidden />
            </span>
          </Link>
        }
      />
      <div className="grid grid-cols-2 border-l border-t border-border/60 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
        {list.map((brand) => (
          <Link
            key={brand.slug}
            href={`/${brand.slug}`}
            className="group flex flex-col items-center justify-center gap-3 border-b border-r border-border/60 px-4 py-8 transition-colors duration-300 hover:bg-card"
          >
            {brand.logoUrl ? (
              <>
                <span className="grid h-12 w-full place-items-center">
                  <img src={brand.logoUrl} alt={brand.logoAlt ?? brand.name} loading="lazy" decoding="async" className="max-h-11 w-auto max-w-[80%] object-contain opacity-75 grayscale transition-[opacity,filter] duration-300 group-hover:opacity-100 group-hover:grayscale-0" />
                </span>
                <span className="w-full truncate text-center font-body text-[0.65rem] uppercase tracking-[0.16em] text-muted-foreground">{brand.name}</span>
              </>
            ) : (
              // No logo in the médiathèque yet → a typographic wordmark (never a lone initial).
              <span className="grid min-h-12 w-full place-items-center text-center font-serif text-lg leading-tight tracking-tight text-foreground/80 transition-colors duration-300 group-hover:text-foreground sm:text-xl">
                {brand.name}
              </span>
            )}
          </Link>
        ))}
      </div>
    </PageSection>
  );
}

export type { BlockPresentation };
