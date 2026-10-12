import type { ReactNode } from "react";

import { Breadcrumb, type Crumb } from "@/storefront/components/storefront/breadcrumb";
import { cn } from "@/storefront/lib/utils";

/**
 * The block every shell route opens with: the home hero's geometry applied to
 * a page header (an "envelope"). Hero gutters (12/16px); pulled under the nav
 * band from md so the floating pill sits exactly 12px inside it; radius
 * 28/36/44 (44 = pill 32 + 12 inset, concentric); inner padding puts text on
 * the pill's logo line. Below md it sits 12px under the pill, like the hero.
 * Follow it with the page body at the island gap:
 * `page-container mt-3 sm:mt-5 lg:mt-6` (rhythm.island).
 */
export function PageTop({
  crumbs,
  eyebrow,
  title,
  meta,
  aside,
  children,
  wash = true,
  className,
}: {
  crumbs?: Crumb[];
  eyebrow?: ReactNode;
  title?: ReactNode;
  /** Line(s) under the title: count, blurb… */
  meta?: ReactNode;
  /** Right-aligned actions next to the title (stacks under it on phones). */
  aside?: ReactNode;
  /** Extra content inside the envelope (sub-nav, product grid). */
  children?: ReactNode;
  /** The category header's crimson wash. */
  wash?: boolean;
  className?: string;
}) {
  const hasCrumbs = !!crumbs && crumbs.length > 0;
  return (
    <section className={cn("envelope-wrap", className)}>
      <div className="envelope-x">
        <header className={cn("envelope", wash && "envelope-wash")}>
          {crumbs && hasCrumbs && <Breadcrumb items={crumbs} />}
          {title != null && (
            <div
              className={cn(
                "flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between sm:gap-6",
                hasCrumbs && "mt-4",
              )}
            >
              <div className="min-w-0">
                {eyebrow && <p className="eyebrow text-muted-foreground">{eyebrow}</p>}
                <h1 className={cn("title-page text-foreground", eyebrow && "mt-2")}>{title}</h1>
                {meta && (
                  <div className="mt-2 text-[15px] leading-relaxed text-muted-foreground">
                    {meta}
                  </div>
                )}
              </div>
              {aside && <div className="flex shrink-0 flex-wrap items-center gap-2">{aside}</div>}
            </div>
          )}
          {children}
        </header>
      </div>
    </section>
  );
}
