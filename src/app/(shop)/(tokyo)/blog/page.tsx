import { blogQueries } from "@/modules/blog";
import { buildPageMetadata } from "@/lib/seo/page-metadata";
import { getSeoConfig } from "@/lib/seo/config";
import { buildCollectionGraph } from "@/lib/seo/jsonld";
import { resolveRedirect } from "@/lib/redirects/resolve";
import {
  BlogListView,
  type BlogFeatured,
  type BlogListCategory,
} from "@/storefront/components/storefront/blog/blog-list-view";
import { toBlogCard } from "@/storefront/components/storefront/blog/blog-card";
import {
  BLOG_ABOUT_TEXT,
  BLOG_ABOUT_TITLE,
  BLOG_ALL_LEDE,
  BLOG_ALL_TITLE,
} from "@/storefront/components/storefront/blog/blog-copy";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 12;
const SEARCH_MIN = 2;

type SP = Promise<{ q?: string | string[]; page?: string | string[]; sort?: string | string[] }>;
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v ?? "").trim();
const initialsOf = (name: string | null | undefined) =>
  (name ?? "").split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase() || "TS";

export async function generateMetadata({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const q = first(sp.q);
  if (q.length >= SEARCH_MIN) {
    return buildPageMetadata({
      title: `Recherche : ${q} — Blog`,
      description: `Résultats de recherche pour « ${q} » sur le blog Tokyo Store.`,
      path: "/blog",
      index: false,
    });
  }
  const page = Math.max(1, Math.floor(Number(first(sp.page)) || 1));
  const sort = first(sp.sort);
  // A sorted / paged browse view canonicalises to /blog and is not indexed
  // (same content, different order) — only the default page-1 index is indexable.
  const plain = page === 1 && (!sort || sort === "recent");
  return buildPageMetadata({
    title: "Blog",
    description:
      "Guides d'achat, comparatifs, astuces et actualités high-tech — le blog officiel Tokyo Store.",
    path: "/blog",
    index: plain ? undefined : false,
  });
}

export default async function BlogIndexPage({ searchParams }: { searchParams: SP }) {
  await resolveRedirect("/blog");
  const sp = await searchParams;
  const q = first(sp.q);
  const isSearch = q.length >= SEARCH_MIN;
  const page = Math.max(1, Math.floor(Number(first(sp.page)) || 1));
  const sort = first(sp.sort) === "popular" ? "popular" : "recent";

  const [listing, categories, countsById, seo] = await Promise.all([
    isSearch
      ? blogQueries
          .searchPublishedPosts(q, { limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE })
          .catch(() => ({ items: [], total: 0 }))
      : blogQueries
          .listPublishedPagedPosts({ sort, page, pageSize: PAGE_SIZE })
          .catch(() => ({ items: [], total: 0 })),
    blogQueries.listAllCategories().catch(() => []),
    blogQueries.countPublishedPostsByCategory().catch(() => new Map<string, number>()),
    getSeoConfig().catch(() => null),
  ]);

  const posts = listing.items;
  const total = listing.total;

  // Featured « À la une » — only on page 1 of the browse view.
  const showFeatured = !isSearch && page === 1 && posts.length > 0;
  const featuredPost = showFeatured ? posts[0]! : null;
  const gridPosts = showFeatured ? posts.slice(1) : posts;
  const featured: BlogFeatured | null = featuredPost
    ? {
        ...toBlogCard(featuredPost),
        authorName: featuredPost.author?.name ?? null,
        authorInitials: initialsOf(featuredPost.author?.name),
      }
    : null;

  const chipCats: BlogListCategory[] = [
    { slug: "", name: BLOG_ALL_TITLE, count: 0 },
    ...categories.map((c) => ({ slug: c.slug, name: c.name, count: countsById.get(c.id) ?? 0 })),
  ];
  const totalAll = [...countsById.values()].reduce((a, b) => a + b, 0);

  // Structured data — CollectionPage + ItemList + Breadcrumb (page-1 browse only).
  const siteUrl = seo?.siteUrl ?? "";
  const jsonLd =
    seo && !isSearch && page === 1 && sort === "recent"
      ? buildCollectionGraph(seo, {
          url: `${siteUrl}/blog`,
          name: "Blog",
          description:
            "Guides d'achat, comparatifs, astuces et actualités high-tech — le blog officiel Tokyo Store.",
          breadcrumb: [
            { name: "Accueil", url: `${siteUrl}/` },
            { name: "Blog", url: `${siteUrl}/blog` },
          ],
          productUrls: posts.map((p) => `${siteUrl}/blog/${p.slug}`),
        })
      : null;
  const jsonLdHtml = jsonLd ? JSON.stringify(jsonLd).replace(/</g, "\\u003c") : null;

  return (
    <>
      {jsonLdHtml && (
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdHtml }} />
      )}
      <BlogListView
        mode={isSearch ? "search" : "all"}
        title={isSearch ? `Recherche` : BLOG_ALL_TITLE}
        lede={isSearch ? `Résultats pour « ${q} »` : BLOG_ALL_LEDE}
        aboutTitle={BLOG_ABOUT_TITLE}
        aboutText={BLOG_ABOUT_TEXT}
        categories={chipCats}
        totalAll={totalAll}
        activeCatSlug=""
        crumbLabel={isSearch ? "Recherche" : ""}
        featured={featured}
        posts={gridPosts.map(toBlogCard)}
        total={total}
        page={page}
        pageSize={PAGE_SIZE}
        sort={sort}
        q={q}
        basePath="/blog"
      />
    </>
  );
}
