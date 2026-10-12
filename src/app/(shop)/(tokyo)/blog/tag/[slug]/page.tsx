import { notFound } from "next/navigation";

import { blogQueries } from "@/modules/blog";
import { blogService } from "@/modules/blog/service";
import { buildPageMetadata } from "@/lib/seo/page-metadata";
import { resolveRedirect } from "@/lib/redirects/resolve";
import {
  BlogListView,
  type BlogListCategory,
} from "@/storefront/components/storefront/blog/blog-list-view";
import { toBlogCard } from "@/storefront/components/storefront/blog/blog-card";
import {
  BLOG_ABOUT_TEXT,
  BLOG_ABOUT_TITLE,
} from "@/storefront/components/storefront/blog/blog-copy";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 12;

type SP = Promise<{ page?: string | string[]; sort?: string | string[] }>;
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v ?? "").trim();

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const tag = await blogService.findTagBySlug(slug);
  if (!tag) return {};
  // Tag archives are noindex,follow (kept out of the sitemap) — thin facets.
  return buildPageMetadata({
    title: `#${tag.name} — Blog`,
    description: `Articles taggés « ${tag.name} » sur le blog Tokyo Store.`,
    path: `/blog/tag/${tag.slug}`,
    index: false,
  });
}

export default async function BlogTagPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: SP;
}) {
  const { slug } = await params;
  await resolveRedirect(`/blog/tag/${slug}`);
  const sp = await searchParams;
  const page = Math.max(1, Math.floor(Number(first(sp.page)) || 1));
  const sort = first(sp.sort) === "popular" ? "popular" : "recent";

  const tag = await blogService.findTagBySlug(slug);
  if (!tag) notFound();

  const [listing, categories, countsById] = await Promise.all([
    blogQueries.listPublishedPagedPosts({ tagSlug: slug, sort, page, pageSize: PAGE_SIZE }).catch(() => ({ items: [], total: 0 })),
    blogQueries.listAllCategories().catch(() => []),
    blogQueries.countPublishedPostsByCategory().catch(() => new Map<string, number>()),
  ]);

  const chipCats: BlogListCategory[] = [
    { slug: "", name: "Tous les articles", count: 0 },
    ...categories.map((c) => ({ slug: c.slug, name: c.name, count: countsById.get(c.id) ?? 0 })),
  ];
  const totalAll = [...countsById.values()].reduce((a, b) => a + b, 0);

  return (
    <BlogListView
      mode="tag"
      title={`#${tag.name}`}
      lede={`Tous les articles taggés « ${tag.name} ».`}
      aboutTitle={BLOG_ABOUT_TITLE}
      aboutText={BLOG_ABOUT_TEXT}
      categories={chipCats}
      totalAll={totalAll}
      activeCatSlug=""
      crumbLabel={`#${tag.name}`}
      featured={null}
      posts={listing.items.map(toBlogCard)}
      total={listing.total}
      page={page}
      pageSize={PAGE_SIZE}
      sort={sort}
      q=""
      basePath={`/blog/tag/${tag.slug}`}
    />
  );
}
