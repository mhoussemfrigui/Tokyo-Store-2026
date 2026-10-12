import type { ReactNode } from "react";
import Link from "next/link";
import { ChevronRight, Clock, Home } from "lucide-react";

import { cn } from "@/storefront/lib/utils";
import type { PublicBlogPost } from "@/modules/blog";
import { BlogCard, type BlogCardData, formatBlogDate, readingLabel } from "./blog-card";
import { BlogProgressBar, BlogToc, BlogTocMobile } from "./blog-reader";
import { BlogShare } from "./blog-share";
import type { TocSection } from "./blog-toc";

/** A product cited in an article (resolved from the blog_post_products link). */
export type BlogCitedProduct = {
  slug: string;
  name: string;
  brand: string | null;
  price: number;
  imageUrl: string | null;
};

function initialsOf(name: string): string {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase() || "TS";
}

export function BlogArticleView({
  post,
  bodyHtml,
  sections,
  authorName,
  cited,
  related,
  shareUrl,
  comments,
}: {
  post: PublicBlogPost;
  bodyHtml: string;
  sections: TocSection[];
  authorName: string | null;
  cited: BlogCitedProduct[];
  related: BlogCardData[];
  shareUrl: string;
  comments: ReactNode;
}) {
  const author = post.author;
  const displayName = author?.name || authorName || "La rédaction";
  const date = formatBlogDate(post.published_at ? new Date(post.published_at).toISOString() : null, "long");
  const read = readingLabel(post.reading_minutes);
  const hasToc = sections.length > 1;
  const hasCited = cited.length > 0;

  return (
    <>
      <BlogProgressBar />
      <div className="page-container flex flex-col gap-5 pt-3">
        {/* Header */}
        <section className="flex flex-col gap-[clamp(22px,3vw,32px)] rounded-[clamp(24px,4vw,36px)] bg-card p-[clamp(24px,4vw,48px)]">
          <nav aria-label="Fil d'Ariane" className="flex items-center gap-1.5 overflow-hidden whitespace-nowrap text-[13px]">
            <Link href="/" aria-label="Accueil" className="grid size-[30px] shrink-0 place-items-center rounded-full bg-background text-foreground transition-colors hover:bg-primary/10 hover:text-primary">
              <Home aria-hidden className="size-3.5" strokeWidth={2} />
            </Link>
            <ChevronRight aria-hidden className="size-3 shrink-0 text-border" strokeWidth={2.4} />
            <Link href="/blog" className="px-0.5 py-1 text-muted-foreground transition-colors hover:text-primary">Blog</Link>
            {post.category && (
              <>
                <ChevronRight aria-hidden className="size-3 shrink-0 text-border" strokeWidth={2.4} />
                <Link href={`/blog/${post.category.slug}`} className="px-0.5 py-1 text-muted-foreground transition-colors hover:text-primary">{post.category.name}</Link>
              </>
            )}
            <ChevronRight aria-hidden className="size-3 shrink-0 text-border" strokeWidth={2.4} />
            <span aria-current="page" className="min-w-0 truncate rounded-full bg-primary/10 px-3 py-1.5 font-semibold text-primary">{post.title}</span>
          </nav>

          <div className="flex max-w-[980px] flex-col gap-5">
            <span className="flex flex-wrap gap-2">
              {post.category && (
                <span className="inline-flex h-7 w-max items-center rounded-full bg-primary/10 px-3 text-[12px] font-extrabold tracking-[0.04em] text-primary">{post.category.name}</span>
              )}
              {post.tags.slice(0, 2).map((t) => (
                <span key={t.id} className="inline-flex h-7 w-max items-center rounded-full bg-muted px-3 text-[12px] font-extrabold tracking-[0.04em] text-foreground">{t.name}</span>
              ))}
            </span>
            <h1 className="m-0 text-[clamp(36px,5.4vw,76px)] font-black leading-[0.98] tracking-[-0.045em] text-balance">{post.title}</h1>
            {post.excerpt && <p className="m-0 max-w-[64ch] text-[19px] leading-[1.6] text-graphite text-pretty">{post.excerpt}</p>}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-4 border-t border-border pt-[22px]">
            <span className="flex items-center gap-3">
              {author?.avatarUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={author.avatarUrl} alt={displayName} className="size-12 rounded-full object-cover" />
              ) : (
                <span className="grid size-12 place-items-center rounded-full bg-primary text-[15px] font-extrabold text-primary-foreground">{initialsOf(displayName)}</span>
              )}
              <span className="flex flex-col gap-0.5">
                <span className="text-[15px] font-extrabold">{displayName}</span>
                <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-muted-foreground">
                  {date && <span>Publié le {date}</span>}
                  {date && read && <span aria-hidden className="size-1 rounded-full bg-border" />}
                  {read && (
                    <span className="flex items-center gap-1.5">
                      <Clock aria-hidden className="size-[13px]" strokeWidth={2} />
                      {read} de lecture
                    </span>
                  )}
                </span>
              </span>
            </span>
            <BlogShare url={shareUrl} title={post.title} />
          </div>
        </section>

        {/* Hero image */}
        {post.featuredImageUrl && (
          <section className="relative overflow-hidden rounded-[clamp(28px,4vw,36px)] bg-card">
            <div className="aspect-[4/3] min-[560px]:aspect-video min-[900px]:aspect-[21/9]">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={post.featuredImageUrl} alt={post.featuredImageAlt || post.title} className="absolute inset-[8%_0] size-full h-[84%] w-full object-contain" />
            </div>
          </section>
        )}

        {/* Content: TOC + article + cited */}
        {hasToc && <div className="min-[900px]:hidden"><BlogTocMobile sections={sections} /></div>}
        <section className="grid items-start gap-5 min-[900px]:grid-cols-[220px_minmax(0,1fr)] min-[1180px]:grid-cols-[220px_minmax(0,1fr)_260px]">
          {hasToc ? (
            <div className="hidden min-[900px]:block"><BlogToc sections={sections} /></div>
          ) : (
            <div className="hidden min-[900px]:block" />
          )}

          <article className="flex min-w-0 justify-center rounded-[clamp(28px,4vw,36px)] bg-card p-[clamp(20px,5vw,64px)]">
            <div className="flex w-full max-w-[700px] flex-col gap-[22px]">
              <div className="blog-prose" dangerouslySetInnerHTML={{ __html: bodyHtml }} />

              {/* Tags */}
              {post.tags.length > 0 && (
                <div className="flex flex-wrap gap-2 border-t border-border pt-[22px]">
                  {post.tags.map((t) => (
                    <Link key={t.id} href={`/blog/tag/${t.slug}`} className="inline-flex h-9 items-center rounded-full bg-muted px-3.5 text-[13px] font-bold text-foreground transition-colors hover:bg-primary/10 hover:text-primary">
                      #{t.name}
                    </Link>
                  ))}
                </div>
              )}

              {/* Author bio */}
              <div className="flex flex-wrap items-center gap-4 rounded-[28px] border border-border bg-muted p-[22px]">
                {author?.avatarUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={author.avatarUrl} alt={displayName} className="size-[60px] shrink-0 rounded-full object-cover" />
                ) : (
                  <span className="grid size-[60px] shrink-0 place-items-center rounded-full bg-primary text-[18px] font-extrabold text-primary-foreground">{initialsOf(displayName)}</span>
                )}
                <span className="flex flex-1 basis-[260px] flex-col gap-1">
                  <span className="text-[12px] font-extrabold uppercase tracking-[0.12em] text-muted-foreground">Écrit par</span>
                  <span className="text-[17px] font-extrabold">{displayName}</span>
                  {author?.jobTitle && <span className="text-[14px] leading-[1.55] text-muted-foreground">{author.jobTitle}</span>}
                </span>
              </div>
            </div>
          </article>

          {hasCited && (
            <aside className="sticky top-4 hidden flex-col gap-3 min-[1180px]:flex">
              <CitedCard cited={cited} />
            </aside>
          )}
        </section>

        {/* Cited — mobile/tablet rail (below the article, when the aside is hidden) */}
        {hasCited && (
          <section className="min-[1180px]:hidden">
            <div className="flex flex-col gap-3.5 rounded-[32px] bg-foreground p-[18px] text-background">
              <span className="px-1 text-[11px] font-extrabold uppercase tracking-[0.14em] text-[#ff8aa0]">Cités dans l&apos;article</span>
              <div className="-mx-[18px] flex gap-2.5 overflow-x-auto px-[18px] [scroll-snap-type:x_mandatory] [scrollbar-width:none]">
                {cited.map((p) => (
                  <Link key={p.slug} href={`/${p.slug}`} className="flex w-[min(280px,78%)] shrink-0 items-center gap-3 rounded-[20px] bg-white/[0.06] p-2.5 [scroll-snap-align:start] transition-colors hover:bg-white/[0.1]">
                    <CitedThumb product={p} size={60} />
                    <span className="flex min-w-0 flex-1 flex-col gap-1">
                      <span className="line-clamp-2 text-[14px] font-bold leading-[1.3]">{p.name}</span>
                      <span className="text-[15px] font-black text-[#ff8aa0]">{p.price.toLocaleString("fr-TN")} TND</span>
                    </span>
                  </Link>
                ))}
              </div>
            </div>
          </section>
        )}

        {/* À lire ensuite */}
        {related.length > 0 && (
          <section className="flex flex-col gap-[18px] pt-3">
            <div className="flex flex-wrap items-end justify-between gap-3 px-1">
              <h2 className="m-0 text-[clamp(26px,3vw,38px)] font-black leading-[1.05] tracking-[-0.035em]">À lire ensuite</h2>
              <Link href={post.category ? `/blog/${post.category.slug}` : "/blog"} className="inline-flex items-center gap-2 text-[15px] font-bold text-foreground transition-colors hover:text-primary">
                {post.category ? `Tous les ${post.category.name.toLowerCase()}` : "Tous les articles"}
                <ChevronRight aria-hidden className="size-4" strokeWidth={2} />
              </Link>
            </div>
            <div className="grid gap-4 min-[560px]:grid-cols-2 min-[900px]:grid-cols-3">
              {related.map((r) => (
                <BlogCard key={r.slug} post={r} />
              ))}
            </div>
          </section>
        )}

        {/* Comments */}
        {comments}
      </div>
    </>
  );
}

function CitedCard({ cited }: { cited: BlogCitedProduct[] }) {
  return (
    <div className="flex flex-col gap-3 rounded-[28px] bg-foreground p-[18px] text-background">
      <span className="text-[11px] font-extrabold uppercase tracking-[0.14em] text-[#ff8aa0]">Cités dans l&apos;article</span>
      {cited.map((p) => (
        <Link key={p.slug} href={`/${p.slug}`} className="flex items-center gap-3 rounded-[18px] bg-white/[0.06] p-2 transition-colors hover:bg-white/[0.1]">
          <CitedThumb product={p} size={52} />
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="line-clamp-2 text-[13px] font-bold leading-[1.3]">{p.name}</span>
            <span className="text-[14px] font-black text-[#ff8aa0]">{p.price.toLocaleString("fr-TN")} TND</span>
          </span>
        </Link>
      ))}
    </div>
  );
}

function CitedThumb({ product, size }: { product: BlogCitedProduct; size: number }) {
  return (
    <span
      className="grid shrink-0 place-items-center overflow-hidden rounded-[14px] bg-card"
      style={{ width: size, height: size }}
    >
      {product.imageUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={product.imageUrl} alt="" loading="lazy" className="size-[86%] object-contain" />
      ) : null}
    </span>
  );
}
