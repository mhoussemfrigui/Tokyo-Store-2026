import Link from "next/link";
import type { ElementType, ReactNode } from "react";
import { ArrowRight, ArrowUpRight } from "lucide-react";

import { chip } from "@/storefront/components/storefront/ui-classes";
import { cn } from "@/storefront/lib/utils";

/**
 * One section heading everywhere: optional eyebrow, the title-section h2,
 * optional action on the right. Follow it with rhythm.head.
 * The eyebrow gets its own full-width line; only the title shares a row with
 * the action, which is centred on the title's last line. On a 390px phone the
 * 44px view-all disc + gap left the eyebrow 306px and orphaned words
 * ("E-" / "MAIL"); on its own line it has the whole 366px column.
 */
export function SectionHeading({
  eyebrow,
  title,
  action,
  id,
  as: Tag = "h2",
  accent = false,
  className,
}: {
  eyebrow?: ReactNode;
  title: ReactNode;
  action?: ReactNode;
  id?: string;
  as?: ElementType;
  accent?: boolean;
  className?: string;
}) {
  return (
    <div className={className}>
      {eyebrow && (
        <p className={cn("eyebrow", accent ? "text-primary-ink" : "text-muted-foreground")}>
          {eyebrow}
        </p>
      )}
      <div className={cn("flex items-end justify-between gap-4", eyebrow && "mt-2")}>
        <Tag id={id} className="title-section min-w-0 text-foreground">
          {title}
        </Tag>
        {action && (
          <div className="title-section-line flex shrink-0 items-center gap-2">{action}</div>
        )}
      </div>
    </div>
  );
}

/**
 * "Voir tout" link in the reference accent-chip language. 44px (chip.lg) on
 * every pointer, the height of the RailArrows it sits beside. Below sm it is
 * a 44×44 arrow-only disc (the label stays for screen readers): with the full
 * chip, phone section headings and their eyebrow wrapped to two lines.
 * External hrefs open in a new tab.
 */
export function ViewAllLink({
  href,
  children = "Voir tout",
  className,
}: {
  href: string;
  children?: ReactNode;
  className?: string;
}) {
  const cls = cn(
    chip.base,
    chip.accent,
    "h-11 px-4 max-sm:w-11 max-sm:justify-center max-sm:px-0",
    className,
  );
  const label = <span className="max-sm:sr-only">{children}</span>;
  if (/^https?:/.test(href)) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" className={cls}>
        {label}
        <span className="sr-only"> (nouvel onglet)</span>
        <ArrowUpRight aria-hidden className="size-4" />
      </a>
    );
  }
  return (
    <Link href={href} className={cls}>
      {label}
      <ArrowRight aria-hidden className="size-4" />
    </Link>
  );
}
