import type { ReactNode } from "react";

import { valuePropIcon } from "@/lib/catalog/value-prop-icons";
import type { BlockHeader } from "@/lib/pages/block-model";
import { cn } from "@/storefront/lib/utils";

/**
 * Shared primitives for the info-pages block renderer — the crimson « X Pages »
 * design language: white rounded-36 section cards, uppercase crimson eyebrows,
 * tight display titles, crimson icon discs, #fbf9f8 fields. Built on the
 * storefront theme tokens (bg-card / text-primary / text-foreground /
 * text-muted-foreground / border-border) so the whole family stays themeable
 * while reproducing the mockup exactly.
 */

/** A white section card (the mockup's `background:#fff;border-radius:36px`). */
export function InfoSection({
  children,
  className,
  tone = "card",
  as: Tag = "section",
  ...rest
}: {
  children: ReactNode;
  className?: string;
  tone?: "card" | "dark" | "plain";
  as?: "section" | "div" | "article";
} & { id?: string }) {
  const toneClass =
    tone === "dark"
      ? "bg-foreground text-background"
      : tone === "plain"
        ? ""
        : "bg-card text-foreground";
  return (
    <Tag
      className={cn(
        "flex min-w-0 flex-col gap-6",
        tone !== "plain" && "rounded-[clamp(24px,3vw,36px)] p-[clamp(22px,3.4vw,44px)]",
        toneClass,
        className,
      )}
      {...rest}
    >
      {children}
    </Tag>
  );
}

/** Uppercase crimson eyebrow (12px/800/.16em). `tone="pink"` for dark cards. */
export function Eyebrow({ children, tone = "crimson" }: { children: ReactNode; tone?: "crimson" | "pink" | "muted" }) {
  return (
    <span
      className={cn(
        "text-[12px] font-extrabold uppercase tracking-[0.16em]",
        tone === "pink" ? "text-[#ff8aa0]" : tone === "muted" ? "text-muted-foreground" : "text-primary",
      )}
    >
      {children}
    </span>
  );
}

/** Tight display heading (clamp 26→38, 900, -.035em, balanced). */
export function SectionTitle({
  children,
  className,
  as: Tag = "h2",
}: {
  children: ReactNode;
  className?: string;
  as?: "h1" | "h2" | "h3";
}) {
  return (
    <Tag
      className={cn(
        "m-0 text-[clamp(26px,3vw,38px)] font-black leading-[1.05] tracking-[-0.035em] text-balance",
        className,
      )}
    >
      {children}
    </Tag>
  );
}

/** Section head: eyebrow + title + optional subtitle, from a block header. */
export function SectionHead({
  header,
  eyebrowTone,
  className,
  level = 2,
}: {
  header: Partial<BlockHeader>;
  eyebrowTone?: "crimson" | "pink" | "muted";
  className?: string;
  level?: 1 | 2 | 3;
}) {
  const hasHead = header.eyebrow || header.title || header.subtitle;
  if (!hasHead) return null;
  return (
    <div className={cn("flex flex-col gap-3", className)}>
      {header.eyebrow && <Eyebrow tone={eyebrowTone}>{header.eyebrow}</Eyebrow>}
      {header.title && (
        <SectionTitle as={level === 1 ? "h1" : level === 3 ? "h3" : "h2"}>{header.title}</SectionTitle>
      )}
      {header.subtitle && <p className={cn("m-0", INFO_LEDE)}>{header.subtitle}</p>}
    </div>
  );
}

/** A crimson icon disc (46px) with a white lucide glyph. */
export function IconDisc({
  icon,
  tone = "crimson",
  size = 46,
}: {
  icon: string;
  tone?: "crimson" | "ink";
  size?: number;
}) {
  const Icon = valuePropIcon(icon);
  const px = size === 46 ? "size-[46px]" : "size-11";
  return (
    <span
      className={cn(
        "grid shrink-0 place-items-center rounded-full",
        px,
        tone === "ink" ? "bg-foreground text-background" : "bg-primary text-primary-foreground",
      )}
    >
      <Icon aria-hidden className="size-[19px]" strokeWidth={2.2} />
    </span>
  );
}

/** Lead paragraph under a title (17px, graphite). */
export const INFO_LEDE = "max-w-[62ch] text-[17px] leading-[1.6] text-graphite text-pretty";
/** Body copy tone used across the info pages (graphite, 1.65 line-height). */
export const INFO_BODY = "text-[16px] leading-[1.65] text-graphite text-pretty";
/** Muted small copy (store subtitles, step bodies). */
export const INFO_MUTED = "text-[14px] leading-[1.55] text-muted-foreground";

/** A soft tinted inner card (#f6f2ed in the mockup → bg-muted). */
export const SOFT_CARD = "rounded-[28px] bg-muted";
