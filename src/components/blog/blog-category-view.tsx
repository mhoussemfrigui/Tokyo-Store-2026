import Link from "next/link";

import { buildCollectionGraph } from "@/lib/seo/jsonld";
import { blogCategoryPath } from "@/lib/blog/paths";
import { BlogPostCard } from "@/components/blog/blog-post-card";
import type { PublicBlogPost } from "@/modules/blog/queries";
import type { BlogCategoryRow } from "@/modules/blog/schema";
import type { getSeoConfig } from "@/lib/seo/config";

type Seo = Awaited<ReturnType<typeof getSeoConfig>> | null;

/**
 * The /blog/<slug> CATEGORY view (served by the flat `/blog/[slug]` route when no
 * post matches the slug). Dark hero + shared card grid + keyset pagination.
 * CollectionPage + Breadcrumb + ItemList JSON-LD on page 1 only (older pages are
 * noindex + canonical to page 1, set in the route's generateMetadata).
 */
export function BlogCategoryView({
  cat,
  posts,
  cursor,
  nextCursor,
  seo,
}: {
  cat: BlogCategoryRow;
  posts: PublicBlogPost[];
  cursor: string | null;
  nextCursor: string | null;
  seo: Seo;
}) {
  const path = blogCategoryPath(cat.slug);
  const siteUrl = (seo?.siteUrl ?? "").replace(/\/$/, "");
  const collectionLd =
    seo && !cursor
      ? buildCollectionGraph(seo, {
          url: `${siteUrl}${path}`,
          name: cat.meta_title?.trim() || `${cat.name} — Blog`,
          description: cat.meta_description?.trim() || cat.description?.trim() || undefined,
          breadcrumb: [
            { name: "Accueil", url: `${siteUrl}/` },
            { name: "Blog", url: `${siteUrl}/blog` },
            { name: cat.name, url: `${siteUrl}${path}` },
          ],
          productUrls: posts.map((p) => `${siteUrl}/blog/${p.slug}`),
        })
      : null;
  const collectionLdHtml = collectionLd ? JSON.stringify(collectionLd).replace(/</g, "\\u003c") : null;

  return (
    <div>
      {collectionLdHtml && (
        <script
          type="application/ld+json"
          // eslint-disable-next-line react/no-danger
          dangerouslySetInnerHTML={{ __html: collectionLdHtml }}
        />
      )}

      <section className="border-b border-border bg-foreground text-background">
        <div className="mx-auto max-w-[1400px] px-4 py-12 sm:px-6 sm:py-16">
          <nav className="text-xs">
            <Link href="/blog" className="text-background/60 transition hover:text-background">
              Blog
            </Link>
            <span className="mx-2 text-background/40">›</span>
            <span className="text-background">{cat.name}</span>
          </nav>
          <p className="mt-5 text-xs font-semibold uppercase tracking-[0.18em] text-background/60">Catégorie</p>
          <h1 className="mt-2 font-display text-3xl font-bold leading-tight tracking-tight sm:text-4xl md:text-5xl">
            {cat.name}
          </h1>
          {cat.description && <p className="mt-3 max-w-lg text-base text-background/70">{cat.description}</p>}
        </div>
      </section>

      <section className="mx-auto max-w-[1400px] px-4 py-10 sm:px-6 sm:py-14">
        {posts.length === 0 && cursor ? (
          <p className="text-sm text-muted-foreground">Aucun article plus ancien.</p>
        ) : posts.length === 0 ? (
          <div className="rounded-3xl border border-dashed border-border bg-card p-16 text-center">
            <p className="text-lg font-semibold">Aucun article dans cette catégorie.</p>
            <p className="mt-2 text-sm text-muted-foreground">Revenez bientôt — de nouveaux articles arrivent.</p>
          </div>
        ) : (
          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {posts.map((p) => (
              <BlogPostCard
                key={p.id}
                showCategory={false}
                post={{
                  slug: p.slug,
                  title: p.title,
                  excerpt: p.excerpt,
                  featuredImageUrl: p.featuredImageUrl,
                  featuredImageAlt: p.featuredImageAlt,
                  publishedAt: p.published_at ? p.published_at.toISOString() : null,
                  readingMinutes: p.reading_minutes,
                }}
              />
            ))}
          </div>
        )}

        {(cursor || nextCursor) && (
          <nav aria-label="Pagination de la catégorie" className="mt-10 flex flex-wrap items-center justify-between gap-3">
            {cursor ? (
              <Link
                href={path}
                className="rounded-full border border-border bg-card px-4 py-2 text-sm font-medium transition hover:border-foreground/20"
              >
                ← Articles les plus récents
              </Link>
            ) : (
              <span />
            )}
            {nextCursor && (
              <Link
                href={`${path}?cursor=${encodeURIComponent(nextCursor)}`}
                rel="next"
                className="rounded-full border border-border bg-card px-4 py-2 text-sm font-medium transition hover:border-foreground/20"
              >
                Articles plus anciens →
              </Link>
            )}
          </nav>
        )}
      </section>
    </div>
  );
}
