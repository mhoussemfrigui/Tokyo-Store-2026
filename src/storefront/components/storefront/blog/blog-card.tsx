import Link from "next/link";
import { Clock } from "lucide-react";

import { cn } from "@/storefront/lib/utils";
import type { PublicBlogPost } from "@/modules/blog";

/** The data an article card needs (mapped from PublicBlogPost at the call site). */
export type BlogCardData = {
  slug: string;
  title: string;
  excerpt: string | null;
  imageUrl: string | null;
  imageAlt: string | null;
  categoryName: string | null;
  publishedAt: string | null;
  readingMinutes: number | null;
};

const DATE_SHORT = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "short", year: "numeric" });
const DATE_LONG = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "long", year: "numeric" });

/** « 6 oct. 2026 » (short) / « 6 octobre 2026 » (long). "" when absent/invalid. */
export function formatBlogDate(iso: string | null | undefined, variant: "short" | "long" = "short"): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return (variant === "long" ? DATE_LONG : DATE_SHORT).format(d);
}

export function readingLabel(minutes: number | null | undefined): string {
  return minutes && minutes > 0 ? `${minutes} min` : "";
}

/** Map an enriched post to the lightweight card DTO. */
export function toBlogCard(p: PublicBlogPost): BlogCardData {
  return {
    slug: p.slug,
    title: p.title,
    excerpt: p.excerpt,
    imageUrl: p.featuredImageUrl,
    imageAlt: p.featuredImageAlt,
    categoryName: p.category?.name ?? null,
    publishedAt: p.published_at ? new Date(p.published_at).toISOString() : null,
    readingMinutes: p.reading_minutes,
  };
}

/** The crimson article card (mockup « Articles » grid tile). */
export function BlogCard({ post, className }: { post: BlogCardData; className?: string }) {
  const date = formatBlogDate(post.publishedAt, "short");
  const read = readingLabel(post.readingMinutes);
  return (
    <Link
      href={`/blog/${post.slug}`}
      className={cn(
        "group flex min-w-0 flex-col overflow-hidden rounded-[32px] bg-card text-foreground transition-[transform,box-shadow] duration-300 hover:-translate-y-1 hover:shadow-[0_22px_50px_rgba(14,18,24,0.08)]",
        className,
      )}
    >
      <span className="relative mx-2.5 mt-2.5 block aspect-[4/3] overflow-hidden rounded-[24px] bg-muted">
        {post.imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={post.imageUrl}
            alt={post.imageAlt || ""}
            loading="lazy"
            decoding="async"
            className="absolute inset-[12%] size-[76%] object-contain mix-blend-multiply transition-transform duration-500 group-hover:scale-[1.04]"
          />
        ) : (
          <span className="absolute inset-0 grid place-items-center text-[13px] font-semibold text-muted-foreground">
            {post.categoryName || "Article"}
          </span>
        )}
        {post.categoryName && (
          <span className="absolute left-3 top-3 inline-flex h-7 items-center rounded-full bg-card px-3 text-[12px] font-extrabold text-foreground">
            {post.categoryName}
          </span>
        )}
      </span>
      <span className="flex flex-1 flex-col gap-2.5 px-5 pb-[22px] pt-[18px]">
        <span className="text-[19px] font-extrabold leading-[1.25] tracking-[-0.015em] text-balance">{post.title}</span>
        {post.excerpt && (
          <span className="line-clamp-2 text-[14px] leading-[1.55] text-muted-foreground">{post.excerpt}</span>
        )}
        {(date || read) && (
          <span className="mt-auto flex flex-wrap items-center gap-x-3 gap-y-1.5 pt-1.5 text-[13px] text-muted-foreground">
            {date && <span>{date}</span>}
            {date && read && <span aria-hidden className="size-1 rounded-full bg-border" />}
            {read && (
              <span className="flex items-center gap-1.5">
                <Clock aria-hidden className="size-[13px]" strokeWidth={2} />
                {read}
              </span>
            )}
          </span>
        )}
      </span>
    </Link>
  );
}
