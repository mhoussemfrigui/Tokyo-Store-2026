import { cache } from "react";
import { notFound } from "next/navigation";

import { blogQueries, type PublicBlogPost } from "@/modules/blog";
import { blogService } from "@/modules/blog/service";
import { blogCommentService } from "@/modules/blog/comments";
import { authQueries } from "@/modules/auth";
import { getApprovedThread } from "@/lib/blog/comment-thread";
import { getBlogCommentsConfig } from "@/lib/blog/comments-config";
import { getCurrentUser } from "@/lib/auth/session";
import { buildPageMetadata } from "@/lib/seo/page-metadata";
import { getSeoConfig } from "@/lib/seo/config";
import { orgId, websiteId } from "@/lib/seo/jsonld";
import { authorPath, authorPersonId } from "@/lib/authors/author-path";
import { resolveRedirect } from "@/lib/redirects/resolve";
import { sanitizeRichHtml } from "@/lib/sanitize/rich-html";
import { listProductsByIds } from "@/storefront/lib/api/products";
import { ArticleComments } from "@/components/blog/article-comments";
import {
  BlogArticleView,
  type BlogCitedProduct,
} from "@/storefront/components/storefront/blog/blog-article-view";
import { BlogListView, type BlogListCategory } from "@/storefront/components/storefront/blog/blog-list-view";
import { toBlogCard } from "@/storefront/components/storefront/blog/blog-card";
import { extractToc } from "@/storefront/components/storefront/blog/blog-toc";
import { categoryCopy, BLOG_ALL_TITLE } from "@/storefront/components/storefront/blog/blog-copy";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 12;
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v ?? "").trim();

const getPost = cache((slug: string) => blogQueries.getPublishedPostBySlug(slug));
const getCategory = cache((slug: string) => blogService.findCategoryBySlug(slug));

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const post = await getPost(slug);
  if (post) {
    const published = post.published_at ? new Date(post.published_at).toISOString() : undefined;
    const modified = post.updated_at ? new Date(post.updated_at).toISOString() : published;
    return buildPageMetadata({
      title: post.meta_title || post.title,
      description: post.meta_description || post.excerpt || undefined,
      path: `/blog/${slug}`,
      image: post.featuredImageUrl,
      article: { publishedTime: published, modifiedTime: modified },
    });
  }
  const cat = await getCategory(slug);
  if (cat) {
    const counts = await blogQueries.countPublishedPostsByCategory().catch(() => new Map<string, number>());
    const indexable = !cat.noindex && (counts.get(cat.id) ?? 0) > 0;
    return buildPageMetadata({
      title: cat.meta_title || cat.name,
      description: cat.meta_description || cat.description || `Articles « ${cat.name} » — blog Tokyo Store.`,
      path: `/blog/${cat.slug}`,
      index: indexable ? undefined : false,
    });
  }
  return {};
}

export default async function BlogPostPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ page?: string | string[]; sort?: string | string[] }>;
}) {
  const { slug } = await params;
  await resolveRedirect(`/blog/${slug}`);

  const post = await getPost(slug);
  if (!post) return renderCategoryOrNotFound(slug, searchParams);

  // ── Article ─────────────────────────────────────────────────────────────
  const seo = await getSeoConfig().catch(() => null);
  const siteUrl = (seo?.siteUrl ?? "").replace(/\/$/, "");
  const articleUrl = `${siteUrl}/blog/${slug}`;

  const commentsConfig = await getBlogCommentsConfig().catch(() => null);
  const commentsEnabled = commentsConfig?.enabled ?? false;

  const [productIds, authorFallback, relatedRaw, moreRaw, thread, commentCount, aggregate, user] =
    await Promise.all([
      blogService.listProductIdsForPost(post.id).catch(() => [] as string[]),
      post.author_user_id
        ? authQueries.findUsersByIds([post.author_user_id]).catch(() => new Map())
        : Promise.resolve(new Map()),
      post.category
        ? blogQueries.listPublishedPosts({ categorySlug: post.category.slug, limit: 6 }).catch(() => ({ items: [] as PublicBlogPost[] }))
        : Promise.resolve({ items: [] as PublicBlogPost[] }),
      blogQueries.listPublishedPosts({ limit: 8 }).catch(() => ({ items: [] as PublicBlogPost[] })),
      commentsEnabled ? getApprovedThread(post.id).catch(() => ({ nodes: [], nextCursor: null })) : Promise.resolve({ nodes: [], nextCursor: null }),
      commentsEnabled ? blogCommentService.countApproved(post.id).catch(() => 0) : Promise.resolve(0),
      commentsEnabled && commentsConfig?.ratingsEnabled
        ? blogCommentService.getAggregate(post.id).catch(() => ({ average: 0, count: 0 }))
        : Promise.resolve({ average: 0, count: 0 }),
      commentsEnabled ? getCurrentUser().catch(() => null) : Promise.resolve(null),
    ]);

  // Cited products — resolve the linked ids to live product cards, in the
  // operator's order, dropping any unpublished / missing one.
  const cited: BlogCitedProduct[] = await resolveCited(productIds);

  // Related — up to 3 from the same category, topped up with the newest.
  const related = dedupeRelated(post.slug, relatedRaw.items, moreRaw.items).map(toBlogCard);

  // Author fallback name (the staff who saved the row) when no editorial author.
  const authorName = post.author ? null : (authorFallback.get(post.author_user_id ?? "")?.name ?? null);

  // Body → sanitized HTML + a « Sommaire » from its <h2>s.
  const { html: bodyHtml, sections } = extractToc(sanitizeRichHtml(post.body));

  // Comments slot (the existing client island; renders inside .tokyo).
  let commentsSlot: React.ReactNode = null;
  if (commentsEnabled) {
    const mineRow = user ? await blogCommentService.findByUserAndPost(user.id, post.id).catch(() => null) : null;
    commentsSlot = (
      <section className="rounded-[clamp(28px,4vw,36px)] bg-card p-[clamp(20px,4vw,44px)]">
        <ArticleComments
          postId={post.id}
          slug={slug}
          nodes={thread.nodes}
          nextCursor={thread.nextCursor}
          totalCount={commentCount}
          aggregate={aggregate}
          ratingsEnabled={commentsConfig?.ratingsEnabled ?? false}
          loggedIn={!!user}
          mine={mineRow ? { body: mineRow.body, rating: mineRow.rating } : null}
        />
      </section>
    );
  }

  // JSON-LD — Article + BreadcrumbList @graph.
  const published = post.published_at ? new Date(post.published_at).toISOString() : undefined;
  const modified = post.updated_at ? new Date(post.updated_at).toISOString() : published;
  const authorRef = post.author
    ? { "@type": "Person", "@id": authorPersonId(siteUrl, post.author.slug), name: post.author.name, url: `${siteUrl}${authorPath(post.author.slug)}` }
    : authorName
      ? { "@type": "Person", name: authorName }
      : { "@id": orgId(siteUrl) };
  const crumbs = [
    { name: "Accueil", url: `${siteUrl}/` },
    { name: "Blog", url: `${siteUrl}/blog` },
    ...(post.category ? [{ name: post.category.name, url: `${siteUrl}/blog/${post.category.slug}` }] : []),
    { name: post.title, url: articleUrl },
  ];
  const jsonLd = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Article",
        "@id": `${articleUrl}#article`,
        headline: post.title.slice(0, 110),
        ...(post.meta_description || post.excerpt ? { description: post.meta_description || post.excerpt } : {}),
        ...(post.featuredImageUrl ? { image: [post.featuredImageUrl] } : {}),
        ...(published ? { datePublished: published } : {}),
        ...(modified ? { dateModified: modified } : {}),
        ...(post.category ? { articleSection: post.category.name } : {}),
        inLanguage: "fr-TN",
        author: authorRef,
        publisher: { "@id": orgId(siteUrl) },
        mainEntityOfPage: { "@id": articleUrl },
        isPartOf: { "@id": websiteId(siteUrl) },
        ...(aggregate.count > 0
          ? { aggregateRating: { "@type": "AggregateRating", ratingValue: aggregate.average, reviewCount: aggregate.count } }
          : {}),
      },
      {
        "@type": "BreadcrumbList",
        "@id": `${articleUrl}#breadcrumb`,
        itemListElement: crumbs.map((c, i) => ({ "@type": "ListItem", position: i + 1, name: c.name, item: c.url })),
      },
    ],
  };

  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd).replace(/</g, "\\u003c") }} />
      <BlogArticleView
        post={post}
        bodyHtml={bodyHtml}
        sections={sections}
        authorName={authorName}
        cited={cited}
        related={related}
        shareUrl={articleUrl || `/blog/${slug}`}
        comments={commentsSlot}
      />
    </>
  );
}

// ── helpers ──────────────────────────────────────────────────────────────────
async function resolveCited(productIds: string[]): Promise<BlogCitedProduct[]> {
  if (productIds.length === 0) return [];
  const products = await listProductsByIds(productIds).catch(() => []);
  const bySlugId = new Map(products.map((p) => [p.id, p]));
  return productIds
    .map((id) => bySlugId.get(id))
    .filter((p): p is NonNullable<typeof p> => !!p)
    .map((p) => ({ slug: p.slug, name: p.title, brand: p.brand ?? null, price: p.price, imageUrl: p.image ?? null }));
}

function dedupeRelated(selfSlug: string, sameCat: PublicBlogPost[], more: PublicBlogPost[]): PublicBlogPost[] {
  const out: PublicBlogPost[] = [];
  const seen = new Set<string>([selfSlug]);
  for (const list of [sameCat, more]) {
    for (const p of list) {
      if (out.length >= 3) break;
      if (seen.has(p.slug)) continue;
      seen.add(p.slug);
      out.push(p);
    }
  }
  return out;
}

async function renderCategoryOrNotFound(
  slug: string,
  searchParams: Promise<{ page?: string | string[]; sort?: string | string[] }>,
) {
  const cat = await getCategory(slug);
  if (!cat || !cat.is_active) notFound();
  const sp = await searchParams;
  const page = Math.max(1, Math.floor(Number(first(sp.page)) || 1));
  const sort = first(sp.sort) === "popular" ? "popular" : "recent";

  const [listing, categories, countsById] = await Promise.all([
    blogQueries.listPublishedPagedPosts({ categorySlug: slug, sort, page, pageSize: PAGE_SIZE }).catch(() => ({ items: [], total: 0 })),
    blogQueries.listAllCategories().catch(() => []),
    blogQueries.countPublishedPostsByCategory().catch(() => new Map<string, number>()),
  ]);

  const copy = categoryCopy(cat.description);
  const chipCats: BlogListCategory[] = [
    { slug: "", name: BLOG_ALL_TITLE, count: 0 },
    ...categories.map((c) => ({ slug: c.slug, name: c.name, count: countsById.get(c.id) ?? 0 })),
  ];
  const totalAll = [...countsById.values()].reduce((a, b) => a + b, 0);

  return (
    <BlogListView
      mode="category"
      title={cat.name}
      lede={copy.lede}
      aboutTitle={copy.aboutTitle}
      aboutText={copy.aboutText}
      categories={chipCats}
      totalAll={totalAll}
      activeCatSlug={cat.slug}
      crumbLabel={cat.name}
      featured={null}
      posts={listing.items.map(toBlogCard)}
      total={listing.total}
      page={page}
      pageSize={PAGE_SIZE}
      sort={sort}
      q=""
      basePath={`/blog/${cat.slug}`}
    />
  );
}
