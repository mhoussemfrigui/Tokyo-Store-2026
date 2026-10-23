import type { ReactNode } from "react";
import Link from "next/link";
import { ArrowRight, Check, MapPin, X } from "lucide-react";

import type { ResolvedMedia } from "@/modules/media";
import { valuePropIcon } from "@/lib/catalog/value-prop-icons";
import type { PageBlock } from "@/lib/pages/page-blocks";
import type { BlockHeader, BlockImage } from "@/lib/pages/block-model";
import { DEFAULT_CONTACT_CHANNELS, mapUrlsFor, telHref, whatsappHref } from "@/lib/pages/page-blocks";
import type { ResolvedPage } from "@/lib/pages/page-blocks-data";
import { cn } from "@/storefront/lib/utils";
import { fmtPrice } from "@/storefront/lib/productMeta";
import { imageUrl } from "@/types/catalog";
import { sanitizeRichHtml } from "@/lib/sanitize/rich-html";

import {
  Eyebrow,
  IconDisc,
  INFO_BODY,
  INFO_LEDE,
  INFO_MUTED,
  InfoSection,
  SectionHead,
  SectionTitle,
} from "./info-kit";
import { FaqHelp } from "./faq-help";
import { LegalDoc } from "./legal-doc";
import { JobBoard } from "./job-board";

/**
 * Tokyo-crimson block renderer for the info/CMS pages — renders the editable
 * `pages.blocks` in the « X Pages » mockup design (the counterpart to the legacy
 * gold/serif PageBlocksRenderer, which the crimson storefront does not use). Each
 * block.type maps to a faithful crimson section; interactive blocks (faq search,
 * legal TOC, cookie prefs, contact/apply forms, job board) delegate to client
 * components. Backend-linked blocks (contact_channels / stores / jobs) read the
 * resolved « Identité & contact » site contact + live pickup locations.
 */

type PickedImage = { src: string; alt: string };
function pick(media: Map<string, ResolvedMedia>, im: BlockImage | null | undefined, fallbackAlt = ""): PickedImage | null {
  const m = im?.mediaId ? media.get(im.mediaId) : undefined;
  if (!m?.url) return null;
  return { src: m.url, alt: im?.alt || m.alt || fallbackAlt };
}

type Ctx = { r: ResolvedPage };

const btnPrimary =
  "inline-flex h-14 w-max max-w-full items-center gap-2.5 rounded-full bg-primary px-6 text-[15px] font-bold text-primary-foreground transition-[filter] hover:brightness-95";
const btnOutline =
  "inline-flex h-14 w-max max-w-full items-center gap-2.5 rounded-full border-[1.5px] border-border bg-card px-[22px] text-[15px] font-bold text-foreground transition-colors hover:border-foreground";

/** Render the visible blocks of a resolved page as crimson sections. */
export function InfoBlocks({ resolved }: { resolved: ResolvedPage }) {
  const ctx: Ctx = { r: resolved };
  const blocks = resolved.blocks.filter((b) => b.visible);
  if (blocks.length === 0) {
    return <p className={cn("rounded-[28px] bg-card p-10 text-center", INFO_MUTED)}>Cette page sera bientôt disponible.</p>;
  }
  return (
    <>
      {blocks.map((b) => (
        <BlockNode key={b.id} block={b} ctx={ctx} />
      ))}
    </>
  );
}

function BlockNode({ block, ctx }: { block: PageBlock; ctx: Ctx }) {
  const c = block.config;
  const id = c.anchor || undefined;
  const node = renderBlock(block, ctx);
  if (!node) return null;
  // Legal/forms carry their own section chrome; others are wrapped as needed inside renderBlock.
  return id ? <div id={id} className="scroll-mt-24">{node}</div> : <>{node}</>;
}

function renderBlock(block: PageBlock, ctx: Ctx): ReactNode {
  const c = block.config;
  const h: Partial<BlockHeader> = c.header ?? {};
  const media = ctx.r.media;

  switch (block.type) {
    // ── editorial split (image + text) ─────────────────────────────────────
    case "editorial": {
      const img = pick(media, c.image, h.title ?? "");
      return (
        <InfoSection>
          <div
            className={cn(
              "grid items-center gap-[clamp(20px,3vw,40px)]",
              img ? "md:grid-cols-2" : "grid-cols-1",
            )}
          >
            <div className={cn("flex flex-col gap-4", img && c.imageSide === "left" && "md:order-2")}>
              {h.eyebrow && <Eyebrow>{h.eyebrow}</Eyebrow>}
              {h.title && <SectionTitle>{h.title}</SectionTitle>}
              {c.body && <p className={cn("m-0", INFO_BODY)}>{c.body}</p>}
              {(c.points ?? []).length > 0 && (
                <ul className="mt-1 flex flex-col gap-3">
                  {c.points!.map((p, i) => (
                    <li key={i} className="flex gap-3">
                      <span className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-full bg-primary/10">
                        <Check aria-hidden className="size-3.5 text-primary" strokeWidth={2.6} />
                      </span>
                      <span className="min-w-0">
                        {p.title && <span className="font-bold text-foreground">{p.title}. </span>}
                        <span className={INFO_MUTED}>{p.body}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              {h.ctaLabel && h.ctaHref && (
                <div className="mt-2">
                  <SmartLink href={h.ctaHref} className={btnPrimary}>
                    {h.ctaLabel}
                    <ArrowRight aria-hidden className="size-[17px]" strokeWidth={2.2} />
                  </SmartLink>
                </div>
              )}
            </div>
            {img && (
              <div className="aspect-[4/3] overflow-hidden rounded-[28px] bg-muted">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={img.src} alt={img.alt} loading="lazy" decoding="async" className="size-full object-cover" />
              </div>
            )}
          </div>
        </InfoSection>
      );
    }

    // ── trust / feature cards (icon tiles) ─────────────────────────────────
    case "trust":
    case "feature_cards": {
      const cards = c.cards ?? [];
      if (cards.length === 0 && !h.title) return null;
      const dark = block.type === "feature_cards" || c.presentation?.background === "dark";
      const plain = c.presentation?.background === "default";
      const cardBg = dark ? "bg-foreground text-background" : plain ? "bg-card" : "bg-muted";
      return (
        <InfoSection tone={plain ? "plain" : dark ? "dark" : "card"}>
          <SectionHead header={h} eyebrowTone={dark ? "pink" : "crimson"} />
          <div className="grid gap-3.5 [grid-template-columns:repeat(auto-fit,minmax(min(100%,230px),1fr))]">
            {cards.map((card, i) => (
              <div key={i} className={cn("flex flex-col gap-3.5 rounded-[28px] p-[22px]", cardBg)}>
                {card.icon && <IconDisc icon={card.icon} />}
                <div className="flex flex-col gap-1.5">
                  {card.title && <span className="text-[18px] font-extrabold tracking-[-0.01em]">{card.title}</span>}
                  {card.body && <span className={cn("block", dark ? "text-[14px] leading-[1.55] text-background/70" : INFO_MUTED)}>{card.body}</span>}
                  {card.meta && <span className="mt-1 text-[13px] font-bold text-primary">{card.meta}</span>}
                </div>
              </div>
            ))}
          </div>
        </InfoSection>
      );
    }

    // ── tiers (warranty / plan paliers) ────────────────────────────────────
    case "tiers": {
      const tiers = c.tiers ?? [];
      if (tiers.length === 0) return null;
      return (
        <InfoSection tone="plain" className="gap-3.5">
          <SectionHead header={h} />
          <div className="grid gap-3.5 [grid-template-columns:repeat(auto-fit,minmax(min(100%,260px),1fr))]">
            {tiers.map((t, i) => {
              const dark = t.tone === "dark" || t.tone === "brand";
              return (
                <div
                  key={i}
                  className={cn(
                    "flex flex-col gap-4 rounded-[32px] p-[26px]",
                    dark ? "bg-foreground text-background" : "bg-card",
                  )}
                >
                  {t.icon && <IconDisc icon={t.icon} tone={t.tone === "dark" ? "ink" : "crimson"} />}
                  {t.eyebrow && (
                    <span className={cn("text-[13px] font-extrabold uppercase tracking-[0.12em]", dark ? "text-[#ff8aa0]" : "text-muted-foreground")}>
                      {t.eyebrow}
                    </span>
                  )}
                  <span className="flex items-baseline gap-2">
                    <span className={cn("font-black leading-[0.9] tracking-[-0.05em]", t.unit ? "text-[56px]" : "text-[24px] tracking-[-0.02em] leading-[1.1]")}>
                      {t.value}
                    </span>
                    {t.unit && <span className="text-[18px] font-extrabold">{t.unit}</span>}
                  </span>
                  {t.body && <span className={cn("text-[14px] leading-[1.55]", dark ? "text-background/70" : "text-muted-foreground")}>{t.body}</span>}
                </div>
              );
            })}
          </div>
        </InfoSection>
      );
    }

    // ── checklist (include ✓ / exclude ✗ columns) ──────────────────────────
    case "checklist": {
      const cols = c.columns ?? [];
      if (cols.length === 0) return null;
      return (
        <InfoSection>
          <SectionHead header={h} />
          <div className="grid gap-x-10 gap-y-6 [grid-template-columns:repeat(auto-fit,minmax(min(100%,280px),1fr))]">
            {cols.map((col, i) => {
              const include = col.variant === "include";
              return (
                <div key={i} className="flex flex-col gap-3.5">
                  {col.title && <span className="text-[17px] font-extrabold">{col.title}</span>}
                  <ul className="m-0 flex list-none flex-col gap-3 p-0">
                    {col.items.map((item, j) => (
                      <li key={j} className="flex items-start gap-3 text-[15px] leading-[1.5] text-graphite">
                        <span
                          className={cn(
                            "mt-px grid size-6 shrink-0 place-items-center rounded-full",
                            include ? "bg-success/12 text-success" : "bg-muted text-muted-foreground",
                          )}
                        >
                          {include ? (
                            <Check aria-hidden className="size-3.5" strokeWidth={2.6} />
                          ) : (
                            <X aria-hidden className="size-3.5" strokeWidth={2.6} />
                          )}
                        </span>
                        <span>{item}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>
        </InfoSection>
      );
    }

    // ── steps (numbered process) ───────────────────────────────────────────
    case "steps": {
      const steps = c.steps ?? [];
      if (steps.length === 0 && !h.title) return null;
      return (
        <InfoSection>
          <SectionHead header={h} />
          <ol className="m-0 grid list-none gap-3.5 p-0 [grid-template-columns:repeat(auto-fit,minmax(min(100%,230px),1fr))]">
            {steps.map((s, i) => (
              <li key={i} className="relative flex flex-col gap-2.5 rounded-[28px] border-[1.5px] border-border p-[22px]">
                <span className="text-[13px] font-black tracking-[0.08em] text-primary">{String(i + 1).padStart(2, "0")}</span>
                {s.title && <span className="text-[17px] font-extrabold">{s.title}</span>}
                {s.body && <span className={INFO_MUTED}>{s.body}</span>}
              </li>
            ))}
          </ol>
        </InfoSection>
      );
    }

    // ── cta_band / banner ──────────────────────────────────────────────────
    case "cta_band":
    case "banner": {
      if (!h.title && !h.ctaLabel) return null;
      const style = c.style ?? "brand";
      // Optional background image (médiathèque) + a mobile-specific variant. When
      // set, the band shows the image under a dark overlay instead of a flat colour
      // — previously both were ignored (M-04 part 2). Over an image the text/buttons
      // follow the `dark` treatment (light text) for contrast, minus the bg colour.
      const bg = pick(media, c.image, h.title ?? "");
      const bgMobile = pick(media, c.imageMobile, h.title ?? "");
      const textStyle = bg ? "dark" : style;
      const tone = bg
        ? "text-background"
        : style === "light"
          ? "bg-card text-foreground"
          : style === "brand"
            ? "bg-primary text-primary-foreground"
            : "bg-foreground text-background";
      return (
        <section className={cn("relative flex flex-col gap-5 overflow-hidden rounded-[clamp(24px,3vw,36px)] p-[clamp(24px,4vw,44px)]", tone)}>
          {bg && (
            <>
              <picture>
                {bgMobile && <source media="(max-width: 640px)" srcSet={bgMobile.src} />}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={bg.src} alt={bg.alt} loading="lazy" decoding="async" className="absolute inset-0 -z-10 size-full object-cover" />
              </picture>
              <span aria-hidden className="absolute inset-0 -z-10 bg-foreground/60" />
            </>
          )}
          <div className="flex flex-col gap-2.5">
            {h.eyebrow && <span className={cn("text-[12px] font-extrabold uppercase tracking-[0.16em]", textStyle === "brand" ? "text-primary-foreground/80" : "text-[#ff8aa0]")}>{h.eyebrow}</span>}
            {h.title && <SectionTitle>{h.title}</SectionTitle>}
            {h.subtitle && <p className={cn("m-0 max-w-[62ch] text-[16px] leading-[1.6]", textStyle === "brand" ? "text-primary-foreground/85" : "text-background/75")}>{h.subtitle}</p>}
          </div>
          {(h.ctaLabel || c.secondaryCtaLabel) && (
            <div className="flex flex-wrap gap-2.5">
              {h.ctaLabel && h.ctaHref && (
                <SmartLink
                  href={h.ctaHref}
                  className={cn(
                    "inline-flex h-14 w-max max-w-full items-center gap-2.5 rounded-full px-6 text-[15px] font-bold transition-[filter,background-color]",
                    textStyle === "brand" ? "bg-card text-foreground hover:bg-background" : "bg-primary text-primary-foreground hover:brightness-95",
                  )}
                >
                  {h.ctaLabel}
                  <ArrowRight aria-hidden className="size-[17px]" strokeWidth={2.2} />
                </SmartLink>
              )}
              {c.secondaryCtaLabel && c.secondaryCtaHref && (
                <SmartLink
                  href={c.secondaryCtaHref}
                  className="inline-flex h-14 w-max max-w-full items-center gap-2.5 rounded-full border-[1.5px] border-current/30 px-[22px] text-[15px] font-bold"
                >
                  {c.secondaryCtaLabel}
                </SmartLink>
              )}
            </div>
          )}
        </section>
      );
    }

    // ── rich_text (sanitised HTML / legal prose) ───────────────────────────
    case "rich_text": {
      if (!c.body && !h.title) return null;
      return (
        <InfoSection>
          {h.title && <SectionTitle>{h.title}</SectionTitle>}
          {c.body && (
            <div
              className="tk-prose max-w-[74ch] text-[16px] leading-[1.7] text-graphite [&_a]:font-semibold [&_a]:text-primary [&_a]:underline [&_h2]:mb-2 [&_h2]:mt-8 [&_h2]:text-[clamp(20px,2vw,26px)] [&_h2]:font-black [&_h2]:tracking-[-0.02em] [&_h2]:text-foreground [&_h3]:mb-1.5 [&_h3]:mt-5 [&_h3]:text-[17px] [&_h3]:font-bold [&_h3]:text-foreground [&_li]:mt-1.5 [&_ol]:mt-3 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:mt-3 [&_strong]:font-semibold [&_strong]:text-foreground [&_ul]:mt-3 [&_ul]:list-disc [&_ul]:pl-5"
              dangerouslySetInnerHTML={{ __html: sanitizeRichHtml(c.body) }}
            />
          )}
        </InfoSection>
      );
    }

    // ── quote ──────────────────────────────────────────────────────────────
    case "quote": {
      if (!c.body) return null;
      return (
        <InfoSection tone="dark">
          <p className="m-0 text-[clamp(22px,2.6vw,32px)] font-extrabold leading-[1.3] tracking-[-0.02em] text-balance">
            « {c.body} »
          </p>
          {c.attribution && <span className="text-[15px] font-semibold text-[#ff8aa0]">{c.attribution}</span>}
        </InfoSection>
      );
    }

    // ── contact_channels (phone / whatsapp / email / stores / help) ────────
    case "contact_channels":
      return <ContactChannels block={block} ctx={ctx} />;

    // ── stores (atlas / directory) ─────────────────────────────────────────
    case "stores":
      return <Stores block={block} ctx={ctx} />;

    // ── faq (searchable help master/detail or accordion) ───────────────────
    case "faq": {
      const items = c.faq ?? [];
      if (items.length === 0) return null;
      return (
        <FaqHelp
          header={h}
          items={items}
          topics={c.faqTopics ?? []}
          search={c.faqSearch ?? false}
        />
      );
    }

    // ── tiers handled above; legal / forms / jobs → client components ───────
    case "legal_doc":
      return (
        <LegalDoc
          header={h}
          draftNote={c.draftNote ?? ""}
          facts={c.facts ?? []}
          sections={c.sections ?? []}
          cookiePrefs={c.cookiePrefs ?? []}
          showToc={c.showToc ?? true}
          email={ctx.r.site.email || ""}
        />
      );

    // The old demo forms (no backend; faked a success panel) were removed. Show
    // the REAL contact channels / job board instead — no fabricated submission.
    case "contact_form":
      return (
        <ContactChannels
          block={{
            ...block,
            config: {
              header: c.header,
              layout: c.layout ?? "cards",
              channels: c.channels ?? DEFAULT_CONTACT_CHANNELS,
            },
          }}
          ctx={ctx}
        />
      );

    case "apply_form":
      // Real application is by e-mail (mailto) to the configured recruitment /
      // site address — reuse the job board's spontaneous-application flow.
      return (
        <JobBoard
          header={h}
          jobs={(c.jobs ?? []).filter((j) => j.active !== false)}
          emptyText={c.emptyText || ""}
          applyEmail={c.applyEmail || ctx.r.site.email || ""}
          spontaneous={{
            title: c.spontaneousTitle || "Candidature spontanée",
            body: c.spontaneousBody || c.consentText || "",
            ctaLabel: c.spontaneousCtaLabel || "Postuler par e-mail",
          }}
        />
      );

    case "jobs": {
      const jobs = (c.jobs ?? []).filter((j) => j.active !== false);
      return (
        <JobBoard
          header={h}
          jobs={jobs}
          emptyText={c.emptyText || "Aucun poste ouvert pour le moment."}
          applyEmail={c.applyEmail || ctx.r.site.email || ""}
          spontaneous={
            c.spontaneousEnabled !== false
              ? {
                  title: c.spontaneousTitle || "Candidature spontanée",
                  body: c.spontaneousBody || "",
                  ctaLabel: c.spontaneousCtaLabel || "Postuler",
                }
              : null
          }
        />
      );
    }

    // ── catalogue / misc (kept available; simple crimson rendering) ─────────
    case "hero": {
      if (!h.title && !c.body) return null;
      const img = pick(media, c.image, h.title ?? "");
      return (
        <section className="relative overflow-hidden rounded-[clamp(24px,4vw,36px)] bg-card p-[clamp(24px,4vw,48px)]">
          <div className="flex flex-col gap-4">
            {h.eyebrow && <Eyebrow>{h.eyebrow}</Eyebrow>}
            {h.title && <SectionTitle as="h1" className="text-[clamp(32px,5vw,64px)] leading-[0.98] tracking-[-0.045em]">{h.title}</SectionTitle>}
            {c.body && <p className={cn("m-0", INFO_LEDE)}>{c.body}</p>}
            {h.ctaLabel && h.ctaHref && (
              <div className="mt-2 flex flex-wrap gap-2.5">
                <SmartLink href={h.ctaHref} className={btnPrimary}>{h.ctaLabel}<ArrowRight aria-hidden className="size-[17px]" strokeWidth={2.2} /></SmartLink>
                {c.secondaryCtaLabel && c.secondaryCtaHref && (
                  <SmartLink href={c.secondaryCtaHref} className={btnOutline}>{c.secondaryCtaLabel}</SmartLink>
                )}
              </div>
            )}
          </div>
          {img && (
            <div className="mt-6 aspect-[16/7] overflow-hidden rounded-[28px] bg-muted">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={img.src} alt={img.alt} loading="lazy" decoding="async" className="size-full object-cover" />
            </div>
          )}
        </section>
      );
    }

    case "stats": {
      const stats = c.stats ?? [];
      if (stats.length === 0) return null;
      return (
        <InfoSection>
          <SectionHead header={h} />
          <div className="grid gap-3.5 [grid-template-columns:repeat(auto-fit,minmax(min(100%,180px),1fr))]">
            {stats.map((s, i) => {
              const value =
                s.source === "brands" && ctx.r.brandCount != null
                  ? String(ctx.r.brandCount)
                  : s.value;
              return (
                <div key={i} className="flex flex-col gap-1.5 rounded-[28px] bg-muted p-[22px]">
                  <span className="text-[40px] font-black leading-none tracking-[-0.04em] text-primary">{value}</span>
                  {s.label && <span className="text-[15px] font-bold">{s.label}</span>}
                  {s.caption && <span className={INFO_MUTED}>{s.caption}</span>}
                </div>
              );
            })}
          </div>
        </InfoSection>
      );
    }

    case "gallery": {
      const imgs = (c.images ?? []).map((im) => pick(media, im)).filter(Boolean) as PickedImage[];
      if (imgs.length === 0) return null;
      return (
        <InfoSection>
          <SectionHead header={h} />
          <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(min(100%,220px),1fr))]">
            {imgs.map((im, i) => (
              <div key={i} className="aspect-square overflow-hidden rounded-[22px] bg-muted">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={im.src} alt={im.alt} loading="lazy" decoding="async" className="size-full object-cover" />
              </div>
            ))}
          </div>
        </InfoSection>
      );
    }

    // ── timeline (dated vertical rail) ─────────────────────────────────────
    case "timeline": {
      const items = c.timeline ?? [];
      if (items.length === 0 && !h.title) return null;
      return (
        <InfoSection>
          <SectionHead header={h} />
          <ol className="flex flex-col">
            {items.map((it, i) => (
              <li key={i} className="grid grid-cols-[auto_1fr] gap-x-5">
                <div className="flex flex-col items-center">
                  <span className="mt-1.5 size-3 shrink-0 rounded-full bg-primary ring-4 ring-primary/15" />
                  {i < items.length - 1 && <span className="w-px flex-1 bg-border" />}
                </div>
                <div className="pb-9">
                  {it.year && <span className="text-[14px] font-extrabold text-primary">{it.year}</span>}
                  {it.title && <h3 className="mt-1 text-[clamp(18px,2vw,22px)] font-extrabold tracking-[-0.01em]">{it.title}</h3>}
                  {it.description && <p className={cn("mt-1.5", INFO_MUTED)}>{it.description}</p>}
                </div>
              </li>
            ))}
          </ol>
        </InfoSection>
      );
    }

    // ── fifty_fifty (1–3 image + text cards) ───────────────────────────────
    case "fifty_fifty": {
      const cards = c.cards ?? [];
      if (cards.length === 0 && !h.title) return null;
      return (
        <InfoSection>
          <SectionHead header={h} />
          <div className="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(min(100%,280px),1fr))]">
            {cards.map((card, i) => {
              const img = pick(media, card.image, card.title);
              return (
                <div key={i} className="flex flex-col overflow-hidden rounded-[28px] bg-card">
                  {img && (
                    <>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={img.src} alt={img.alt} loading="lazy" decoding="async" className="aspect-[4/3] w-full object-cover" />
                    </>
                  )}
                  <div className="flex flex-col gap-2 p-6">
                    {card.eyebrow && <Eyebrow>{card.eyebrow}</Eyebrow>}
                    {card.title && <h3 className="text-[clamp(18px,2vw,22px)] font-extrabold tracking-[-0.01em]">{card.title}</h3>}
                    {card.body && <p className={INFO_MUTED}>{card.body}</p>}
                    {card.ctaLabel && card.ctaHref && (
                      <SmartLink href={card.ctaHref} className="mt-1 inline-flex w-max items-center gap-1.5 text-[15px] font-bold text-primary">
                        {card.ctaLabel} <ArrowRight className="size-4" aria-hidden />
                      </SmartLink>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </InfoSection>
      );
    }

    // ── product_grid (embed a catalogue listing; products resolved server-side) ─
    case "product_grid": {
      const prods = ctx.r.productsByBlock.get(block.id) ?? [];
      if (prods.length === 0 && !h.title) return null;
      return (
        <InfoSection>
          <SectionHead header={h} />
          <div className="grid gap-3.5 [grid-template-columns:repeat(auto-fill,minmax(min(100%,200px),1fr))]">
            {prods.map((p) => {
              const imgSrc = imageUrl(p.image);
              return (
                <Link
                  key={p.slug}
                  href={`/${p.slug}`}
                  className="group flex flex-col gap-2 rounded-card border border-border bg-card p-2 transition-[transform,box-shadow] duration-200 hover:-translate-y-1 hover:shadow-island"
                >
                  <div className="aspect-square overflow-hidden rounded-media bg-product-media">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={imgSrc} alt="" loading="lazy" decoding="async" className="size-full object-contain" />
                  </div>
                  <div className="flex flex-col gap-1 px-1.5 pb-1.5">
                    <span className="line-clamp-2 min-h-[38px] text-sm font-bold leading-[1.35] text-foreground transition-colors group-hover:text-primary">
                      {p.name}
                    </span>
                    <span className="text-[18px] font-extrabold leading-none text-primary">
                      {fmtPrice(p.price)} <span className="text-[11px] font-bold">TND</span>
                    </span>
                  </div>
                </Link>
              );
            })}
          </div>
        </InfoSection>
      );
    }

    // ── categories (category cards; refs filter, [] = all) ─────────────────
    case "categories": {
      const refs = c.refs ?? [];
      const cats = refs.length ? ctx.r.categories.filter((cat) => refs.includes(cat.slug)) : ctx.r.categories;
      if (cats.length === 0 && !h.title) return null;
      return (
        <InfoSection>
          <SectionHead header={h} />
          <div className="grid gap-3.5 [grid-template-columns:repeat(auto-fill,minmax(min(100%,190px),1fr))]">
            {cats.map((cat) => {
              const img = cat.boutiqueImageMediaId ? media.get(cat.boutiqueImageMediaId) : undefined;
              return (
                <Link
                  key={cat.slug}
                  href={`/${cat.slug}`}
                  className="group relative flex aspect-[4/5] flex-col justify-end overflow-hidden rounded-[24px] bg-foreground p-5 text-background"
                >
                  {img?.url && (
                    <>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={img.url} alt="" loading="lazy" decoding="async" className="absolute inset-0 size-full object-cover opacity-70 transition-transform duration-300 group-hover:scale-105" />
                    </>
                  )}
                  <span aria-hidden className="absolute inset-0 bg-gradient-to-t from-foreground/85 to-transparent" />
                  <span className="relative text-[18px] font-extrabold leading-tight">{cat.name}</span>
                  <span className="relative mt-0.5 text-[13px] font-semibold text-background/70">
                    {cat.count} produit{cat.count === 1 ? "" : "s"}
                  </span>
                </Link>
              );
            })}
          </div>
        </InfoSection>
      );
    }

    // ── brands (logo grid; refs filter, [] = all). Brand pages may not exist,
    //    so logos are non-linking tiles rather than dead buttons. ────────────
    case "brands": {
      const refs = c.refs ?? [];
      const brands = refs.length ? ctx.r.brands.filter((b) => refs.includes(b.slug)) : ctx.r.brands;
      if (brands.length === 0 && !h.title) return null;
      return (
        <InfoSection>
          <SectionHead header={h} />
          <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(min(100%,150px),1fr))]">
            {brands.map((b) => (
              <div key={b.slug} className="flex h-[92px] items-center justify-center rounded-[20px] border border-border bg-card p-4">
                {b.logoUrl ? (
                  <>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={b.logoUrl} alt={b.logoAlt ?? b.name} loading="lazy" decoding="async" className="max-h-full max-w-full object-contain" />
                  </>
                ) : (
                  <span className="text-center text-[15px] font-bold text-foreground">{b.name}</span>
                )}
              </div>
            ))}
          </div>
        </InfoSection>
      );
    }

    default:
      return null;
  }
}

/** An internal Link / external anchor, respecting the model's cleaned hrefs. */
function SmartLink({ href, className, children }: { href: string; className?: string; children: ReactNode }) {
  if (href.startsWith("/") || href.startsWith("#")) {
    return (
      <Link href={href} className={className}>
        {children}
      </Link>
    );
  }
  return (
    <a href={href} className={className} target={href.startsWith("http") ? "_blank" : undefined} rel="noopener noreferrer">
      {children}
    </a>
  );
}

// ── contact_channels ─────────────────────────────────────────────────────────
function ContactChannels({ block, ctx }: { block: PageBlock; ctx: Ctx }) {
  const c = block.config;
  const h: Partial<BlockHeader> = c.header ?? {};
  const site = ctx.r.site;
  // No fabricated fallbacks: the real values come from « Identité & contact »
  // (site.contact_phone / site.contact_email); a channel with no configured value
  // is simply dropped rather than showing an invented number/address.
  const phone = site.phone || "";
  const email = site.email || "";
  const whatsapp = site.whatsapp || phone;
  const rows = (c.channels ?? [])
    .filter((ch) => ch.enabled)
    .map((ch) => {
      switch (ch.key) {
        case "phone":
          return phone
            ? { key: ch.key, label: ch.label || "Appeler", value: phone.replace("+216", "").trim(), note: ch.note || "Lun – sam · 9h – 19h30", href: telHref(phone), icon: "Phone", tone: "crimson" as const }
            : null;
        case "whatsapp":
          return whatsapp
            ? { key: ch.key, label: ch.label || "WhatsApp", value: "Écrire", note: ch.note || "Réponse rapide en journée", href: ch.href || whatsappHref(whatsapp), icon: "MessageCircle", tone: "green" as const }
            : null;
        case "email":
          return email
            ? { key: ch.key, label: ch.label || "E-mail", value: email, note: ch.note || "Sous 24h ouvrées", href: `mailto:${email}`, icon: "Mail", tone: "ink" as const }
            : null;
        case "stores":
          return { key: ch.key, label: ch.label || "Boutique", value: "3 boutiques", note: ch.note || "Lac 2 · La Marsa · Menzah 5", href: ch.href || "/apropos#boutiques", icon: "MapPin", tone: "soft" as const };
        case "help":
          return { key: ch.key, label: ch.label || "Aide & FAQ", value: "Consulter", note: ch.note || "Questions fréquentes", href: ch.href || "/aide", icon: "Headphones", tone: "soft" as const };
        default:
          return null;
      }
    })
    .filter(Boolean) as { key: string; label: string; value: string; note: string; href: string; icon: string; tone: "crimson" | "green" | "ink" | "soft" }[];
  if (rows.length === 0) return null;

  const layout = c.layout ?? "concierge";

  if (layout === "cards") {
    return (
      <section className="grid gap-3.5 [grid-template-columns:repeat(auto-fit,minmax(min(100%,210px),1fr))]">
        {rows.map((row) => {
          const crimson = row.tone === "crimson";
          return (
            <SmartLink
              key={row.key}
              href={row.href || "#"}
              className={cn(
                "flex flex-col gap-4 rounded-[32px] p-[22px] transition-[filter,background-color]",
                crimson ? "bg-primary text-primary-foreground hover:brightness-95" : "bg-card text-foreground hover:bg-muted",
              )}
            >
              <span className={cn("grid size-[46px] shrink-0 place-items-center rounded-full", crimson ? "bg-card text-primary" : row.tone === "green" ? "bg-success text-white" : row.tone === "ink" ? "bg-foreground text-background" : "bg-muted text-foreground")}>
                <IconGlyph name={row.icon} />
              </span>
              <span className="flex flex-col gap-1">
                <span className={cn("text-[13px] font-bold", crimson ? "opacity-85" : "text-muted-foreground")}>{row.label}</span>
                <span className="text-[20px] font-black tracking-[-0.02em] [overflow-wrap:anywhere]">{row.value}</span>
                <span className={cn("text-[13px]", crimson ? "opacity-85" : "text-muted-foreground")}>{row.note}</span>
              </span>
            </SmartLink>
          );
        })}
      </section>
    );
  }

  // concierge / strip → a simple contact-desk list
  return (
    <InfoSection>
      <SectionHead header={h} />
      <div className="flex flex-col gap-2.5">
        {rows.map((row) => (
          <SmartLink key={row.key} href={row.href || "#"} className="flex items-center gap-4 rounded-[22px] bg-muted p-4 transition-colors hover:bg-primary/5">
            <IconDisc icon={row.icon} />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="text-[15px] font-extrabold">{row.label}</span>
              <span className={INFO_MUTED}>{row.value} · {row.note}</span>
            </span>
            <ArrowRight aria-hidden className="size-4 shrink-0 text-primary" strokeWidth={2.2} />
          </SmartLink>
        ))}
      </div>
    </InfoSection>
  );
}

// ── stores ─────────────────────────────────────────────────────────────────
function Stores({ block, ctx }: { block: PageBlock; ctx: Ctx }) {
  const c = block.config;
  const h: Partial<BlockHeader> = c.header ?? {};
  const stores = (c.stores ?? []).map((s) => {
    const live = s.pickupLocationId ? ctx.r.pickups.get(s.pickupLocationId) : undefined;
    return {
      name: live?.name || s.name,
      address: live?.address || s.address,
      city: live?.city || s.city,
      phone: live?.phone || s.phone,
    };
  });
  if (stores.length === 0 && !h.title) return null;
  const directory = c.layout === "directory";

  if (directory) {
    return (
      <InfoSection tone="dark">
        {h.eyebrow && <Eyebrow tone="pink">{h.eyebrow}</Eyebrow>}
        {h.title && <SectionTitle>{h.title}</SectionTitle>}
        <div className="flex flex-col gap-2">
          {stores.map((s, i) => {
            const maps = mapUrlsFor(s.address, s.city);
            return (
              <a
                key={i}
                href={maps?.directions || "#"}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-3.5 rounded-[22px] bg-white/[0.06] p-4 transition-colors hover:bg-white/[0.1]"
              >
                <MapPin aria-hidden className="size-4 shrink-0 text-primary" strokeWidth={2} />
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="text-[16px] font-extrabold">{s.name}</span>
                  {(s.address || s.city) && <span className="text-[13px] text-background/70">{[s.address, s.city].filter(Boolean).join(", ")}</span>}
                </span>
                <span className="shrink-0 whitespace-nowrap text-[13px] font-bold text-[#ff8aa0]">Itinéraire →</span>
              </a>
            );
          })}
        </div>
      </InfoSection>
    );
  }

  // atlas → address cards + one map
  const first = stores[0];
  const maps = first ? mapUrlsFor(first.address, first.city) : null;
  return (
    <InfoSection>
      <SectionHead header={h} />
      <div className="grid items-start gap-3.5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
        <div className="flex flex-col gap-2.5">
          {stores.map((s, i) => (
            <div key={i} className="flex flex-col gap-1 rounded-[22px] bg-muted p-4">
              <span className="text-[16px] font-extrabold">{s.name}</span>
              {(s.address || s.city) && <span className={INFO_MUTED}>{[s.address, s.city].filter(Boolean).join(", ")}</span>}
              {s.phone && <span className="text-[13px] font-semibold text-primary">{s.phone}</span>}
            </div>
          ))}
        </div>
        {maps && (c.showMap ?? true) && (
          <div className="aspect-[4/3] overflow-hidden rounded-[22px] bg-muted lg:sticky lg:top-3">
            <iframe src={maps.embed} title="Carte" loading="lazy" className="size-full border-0" referrerPolicy="no-referrer-when-downgrade" />
          </div>
        )}
      </div>
    </InfoSection>
  );
}

/** Small inline lucide glyph by name (for contact cards), reusing the icon resolver. */
function IconGlyph({ name }: { name: string }) {
  const Icon = valuePropIcon(name);
  return <Icon aria-hidden className="size-[19px]" strokeWidth={2.2} />;
}
