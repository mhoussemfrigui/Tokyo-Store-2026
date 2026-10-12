import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

import { cn } from "@/storefront/lib/utils";

/** The one empty / terminal state: an island with an icon disc, a title, copy and capsule actions. */
export function EmptyState({
  icon: Icon,
  title,
  children,
  actions,
  tone = "accent",
  headingLevel = 2,
  className,
}: {
  icon?: LucideIcon;
  title: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
  tone?: "accent" | "success";
  headingLevel?: 1 | 2 | 3;
  className?: string;
}) {
  const H = `h${headingLevel}` as "h1" | "h2" | "h3";
  return (
    /* Full container width at every breakpoint, so the empty/terminal island
       lines up with the page-container like every other panel (no narrower
       centred box on desktop). The icon/title/copy stay centred inside it. */
    <div
      className={cn(
        "w-full rounded-island border border-border bg-background px-6 py-12 text-center shadow-island sm:py-16",
        className,
      )}
    >
      {Icon && (
        <span
          className={cn(
            "mx-auto grid size-14 place-items-center rounded-full",
            tone === "success" ? "bg-success/10 text-success" : "bg-primary/10 text-primary",
          )}
        >
          <Icon aria-hidden className="size-6" />
        </span>
      )}
      <H className={cn("title-block text-foreground", Icon && "mt-5")}>{title}</H>
      {children && (
        <div className="mx-auto mt-2 max-w-md text-[15px] leading-relaxed text-muted-foreground">
          {children}
        </div>
      )}
      {/* Stacked below sm as a one-column grid sized to the widest action, so
          every capsule stretches to that width (a flex column shrank each to
          its own label: 165 vs 241px). From sm they sit in a centred row. */}
      {actions && (
        <div className="mx-auto mt-6 grid w-fit gap-3 sm:flex sm:w-auto sm:justify-center">
          {actions}
        </div>
      )}
    </div>
  );
}
