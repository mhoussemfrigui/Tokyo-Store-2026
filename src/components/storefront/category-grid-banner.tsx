import Image from "next/image";
import Link from "next/link";
import { ArrowRight } from "lucide-react";

import type { RenderableBanner } from "@/lib/api/cms";

/**
 * DB-driven `category_grid` banner — a full-width editorial card slotted BETWEEN
 * product rows (or pinned above the grid) on listing pages. Its placement is
 * operator-controlled per banner (`grid_position`: top / after_load_more /
 * after_rows), applied by the category client; targeting (`target_kind` /
 * `target_ref`: global, or scoped to a category / brand / filter) is applied by
 * the service. The art-directed image fills a real visual panel — a landscape
 * crop beside the copy on sm+, stacked on top on phones — so the recommended
 * wide (21:9) upload is actually used rather than shrunk to an icon.
 */
export function CategoryGridBanner({ banners }: { banners: RenderableBanner[] }) {
  const banner = banners[0];
  if (!banner) return null;

  const hasImage = Boolean(banner.image || banner.imageMobile);
  // A real link target (safeHref maps blank/unsafe to "#", which is NOT a link —
  // don't wrap the card or render the pill for it).
  const ctaHref = banner.ctaHref && banner.ctaHref !== "#" ? banner.ctaHref : null;
  const hasCta = Boolean(banner.ctaLabel && ctaHref);
  // Base = the desktop crop, or the mobile crop when only it is set; art-direct
  // (two layers) ONLY when both exist, mirroring the hero.
  const baseImage = banner.image ?? banner.imageMobile;
  const mobileImage = banner.image ? banner.imageMobile : null;

  const inner = (
    <div
      className={`relative col-span-full grid overflow-hidden rounded-3xl border border-border/60 bg-card text-foreground ${
        hasImage ? "sm:grid-cols-2" : ""
      }`}
    >
      {hasImage && baseImage && (
        // Landscape visual panel — a 16:9 band on phones, a full-height side
        // panel on sm+ (the copy column sets the height the image fills).
        <div className="relative aspect-[16/9] w-full sm:aspect-auto sm:h-full sm:min-h-[200px]">
          <Image
            src={baseImage}
            alt={banner.imageAlt ?? ""}
            fill
            className={`object-cover ${mobileImage ? "hidden sm:block" : ""}`}
            sizes="(min-width: 640px) 50vw, 100vw"
          />
          {mobileImage && (
            <Image
              src={mobileImage}
              alt={banner.imageAlt ?? ""}
              fill
              className="object-cover sm:hidden"
              sizes="100vw"
            />
          )}
        </div>
      )}

      <div className="flex flex-col justify-center gap-4 px-5 py-6 sm:px-8 sm:py-8">
        <div className="min-w-0">
          {banner.eyebrow && (
            <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
              {banner.eyebrow}
            </p>
          )}
          <h3 className="mt-1 font-display text-xl font-bold leading-tight sm:text-2xl">
            {banner.title}
          </h3>
          {banner.subtitle && (
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{banner.subtitle}</p>
          )}
        </div>

        {hasCta && (
          <span className="inline-flex h-11 w-fit shrink-0 items-center gap-2 rounded-full bg-foreground px-5 text-sm font-semibold text-background">
            {banner.ctaLabel}
            <ArrowRight className="h-4 w-4" strokeWidth={2.4} />
          </span>
        )}
      </div>
    </div>
  );

  // The whole card is the link when a REAL CTA target is set (single-CTA placement,
  // so no nested-link hazard); the visible pill is the affordance. A "#" (blank/
  // unsafe at the read seam) is not a link, so the card stays static.
  if (ctaHref) {
    return (
      <Link href={ctaHref} className="contents">
        {inner}
      </Link>
    );
  }
  return inner;
}
