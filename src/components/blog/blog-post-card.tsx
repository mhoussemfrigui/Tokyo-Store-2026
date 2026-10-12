import Image from "next/image";
import Link from "next/link";

export type BlogPostCardData = {
  slug: string;
  title: string;
  excerpt: string | null;
  featuredImageUrl: string | null;
  featuredImageAlt: string | null;
  category?: { name: string; slug: string } | null;
  publishedAt?: string | null;
  readingMinutes?: number | null;
};

/**
 * ONE blog post card for every listing surface (index, category, tag, author
 * archive) — soft-luxury: 16:10 cover with a slow zoom-on-hover, a gold-tinted
 * category pill, Playfair title, excerpt, and a quiet date / reading-time footer.
 * Replaces the four inline card copies so the surfaces can never drift.
 */
export function BlogPostCard({
  post,
  showCategory = true,
  showMeta = true,
  sizes = "(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 33vw",
}: {
  post: BlogPostCardData;
  showCategory?: boolean;
  showMeta?: boolean;
  sizes?: string;
}) {
  const date =
    showMeta && post.publishedAt
      ? new Date(post.publishedAt).toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" })
      : null;

  return (
    <Link
      href={`/blog/${post.slug}`}
      className="group flex flex-col overflow-hidden rounded-3xl border border-border bg-card transition hover:border-foreground/20 hover:shadow-soft"
    >
      {post.featuredImageUrl ? (
        <div className="relative aspect-[16/10] overflow-hidden bg-surface">
          <Image
            src={post.featuredImageUrl}
            alt={post.featuredImageAlt ?? post.title}
            fill
            sizes={sizes}
            className="object-cover transition duration-500 group-hover:scale-[1.03]"
          />
        </div>
      ) : (
        <div className="aspect-[16/10] bg-gradient-to-br from-primary/15 via-surface to-accent/10" />
      )}
      <div className="flex flex-1 flex-col gap-3 p-5">
        {showCategory && post.category && (
          <span className="inline-flex w-fit items-center rounded-full bg-primary/10 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide text-primary">
            {post.category.name}
          </span>
        )}
        <h3 className="font-display text-lg font-semibold leading-snug text-foreground transition group-hover:text-primary">
          {post.title}
        </h3>
        {post.excerpt && (
          <p className="line-clamp-2 text-sm leading-relaxed text-muted-foreground">{post.excerpt}</p>
        )}
        {showMeta && (date || post.readingMinutes) && (
          <div className="mt-auto flex items-center gap-2 pt-1 text-[11px] text-muted-foreground">
            {date && <span>{date}</span>}
            {date && post.readingMinutes ? <span className="text-border">•</span> : null}
            {post.readingMinutes ? <span>{post.readingMinutes} min</span> : null}
          </div>
        )}
      </div>
    </Link>
  );
}
