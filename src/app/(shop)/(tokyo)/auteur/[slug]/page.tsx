import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { cache } from "react";

import { authorQueries, type AuthorArchivePost, type AuthorRow } from "@/modules/authors";
import { mediaQueries } from "@/modules/media";
import { getSeoConfig } from "@/lib/seo/config";
import { buildPageMetadata } from "@/lib/seo/page-metadata";
import { resolveRedirect } from "@/lib/redirects/resolve";
import { authorPath, authorPersonId, AUTHOR_BASE } from "@/lib/authors/author-path";
import { parseSameAs } from "@/lib/seo/same-as";
import { parseKnowsAbout } from "@/lib/authors/person";
import { websiteId } from "@/lib/seo/jsonld";
import {
  BlogAuthorView,
  type AuthorSocial,
} from "@/storefront/components/storefront/blog/blog-author-view";

// Per-request — reflects the live author profile + their latest posts.
export const dynamic = "force-dynamic";

const PAGE_SIZE = 12;

// ── Pure display helpers (avatar initials / colour, social chips) ────────────
function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

const AVATAR_PALETTE = ["#d40530", "#0e1218", "#2a6f6b", "#9a6410", "#5b3a8c", "#0a66c2", "#b8431e"];
function colorFor(key: string): string {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return AVATAR_PALETTE[h % AVATAR_PALETTE.length]!;
}

const SOCIAL_META: Record<string, { label: string; code: string; bg: string }> = {
  instagram: { label: "Instagram", code: "IG", bg: "linear-gradient(45deg,#f9b233,#e1306c 50%,#833ab4)" },
  facebook: { label: "Facebook", code: "f", bg: "#1877f2" },
  x: { label: "X", code: "X", bg: "#0e1218" },
  twitter: { label: "X", code: "X", bg: "#0e1218" },
  youtube: { label: "YouTube", code: "YT", bg: "#ff0000" },
  tiktok: { label: "TikTok", code: "♪", bg: "#0e1218" },
  linkedin: { label: "LinkedIn", code: "in", bg: "#0a66c2" },
  github: { label: "GitHub", code: "GH", bg: "#0e1218" },
  threads: { label: "Threads", code: "@", bg: "#0e1218" },
  pinterest: { label: "Pinterest", code: "P", bg: "#e60023" },
};
function mapSocial(href: string): AuthorSocial {
  try {
    const host = new URL(href).hostname.replace(/^www\./, "");
    const key = (host.split(".")[0] || host).toLowerCase();
    const m = SOCIAL_META[key];
    if (m) return { href, ...m };
    const label = key.charAt(0).toUpperCase() + key.slice(1);
    return { href, label, code: label.slice(0, 2).toUpperCase(), bg: "#0e1218" };
  } catch {
    return { href, label: "Lien", code: "↗", bg: "#0e1218" };
  }
}

type AuthorData = {
  author: AuthorRow;
  stats: Awaited<ReturnType<typeof authorQueries.getAuthorStats>>;
  posts: AuthorArchivePost[];
  total: number;
  others: Awaited<ReturnType<typeof authorQueries.listOtherAuthorRefs>>;
  avatarUrl: string | null;
  siteUrl: string;
  siteName: string;
};

/** Load an ACTIVE author + a page of their posts + stats + team, ONCE per request. */
const loadAuthor = cache(async function loadAuthor(
  slug: string,
  page: number,
  cat: string,
): Promise<AuthorData | null> {
  const author = await authorQueries.findAuthorBySlug(slug).catch(() => null);
  // A deactivated author is hidden from the public (no page, no byline).
  if (!author || !author.is_active) return null;

  const [stats, archive, others, avatarMap, seo] = await Promise.all([
    authorQueries.getAuthorStats(author.id).catch(() => ({ total: 0, totalMinutes: 0, lastPublishedAt: null, categories: [] })),
    authorQueries.getAuthorArchivePage(author.id, { page, pageSize: PAGE_SIZE, categorySlug: cat || null }).catch(() => ({ posts: [], total: 0 })),
    authorQueries.listOtherAuthorRefs(author.id).catch(() => []),
    author.avatar_media_id
      ? mediaQueries.resolveSocialUrlAltMap([author.avatar_media_id]).catch(() => new Map())
      : Promise.resolve(new Map()),
    getSeoConfig().catch(() => null),
  ]);

  return {
    author,
    stats,
    posts: archive.posts,
    total: archive.total,
    others,
    avatarUrl: author.avatar_media_id ? avatarMap.get(author.avatar_media_id)?.url ?? null : null,
    siteUrl: (seo?.siteUrl ?? "").replace(/\/$/, ""),
    siteName: seo?.siteName ?? "Tokyo Store",
  };
});

function parsePage(v: string | string[] | undefined): number {
  const n = parseInt(Array.isArray(v) ? (v[0] ?? "") : (v ?? ""), 10);
  return Number.isFinite(n) && n > 1 ? n : 1;
}
function parseCat(v: string | string[] | undefined): string {
  return (Array.isArray(v) ? v[0] : v)?.trim() ?? "";
}

export async function generateMetadata({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ page?: string | string[]; cat?: string | string[] }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const sp = await searchParams;
  const page = parsePage(sp.page);
  const data = await loadAuthor(slug, page, parseCat(sp.cat));
  if (!data) return {};
  const { author, stats, avatarUrl } = data;
  const base = await buildPageMetadata({
    title: author.meta_title?.trim() || author.name,
    description:
      author.meta_description?.trim() ||
      author.bio?.trim() ||
      `Articles et guides rédigés par ${author.name}.`,
    path: authorPath(author.slug),
    // Noindex a profile that is individually noindexed, has no posts, or a deeper
    // (paginated/filtered) page; else `undefined` so the site robots ceiling applies.
    index: author.noindex || stats.total === 0 || page > 1 ? false : undefined,
    image: avatarUrl,
  });
  const withProfile = { ...base, openGraph: { ...base.openGraph, type: "profile" as const } };
  const canonical = author.canonical_url?.trim();
  return canonical
    ? { ...withProfile, alternates: { ...withProfile.alternates, canonical } }
    : withProfile;
}

export default async function AuthorPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ page?: string | string[]; cat?: string | string[] }>;
}) {
  const { slug } = await params;
  await resolveRedirect(`${AUTHOR_BASE}/${slug}`);
  const sp = await searchParams;
  const page = parsePage(sp.page);
  const cat = parseCat(sp.cat);
  const data = await loadAuthor(slug, page, cat);
  if (!data) notFound();
  const { author, stats, posts, total, others, avatarUrl, siteUrl, siteName } = data;
  // An out-of-range page (URL manipulation) would otherwise show an empty grid +
  // a « never published » message for an author who has articles — 404 it instead.
  if (total > 0 && (page - 1) * PAGE_SIZE >= total) notFound();

  const knowsAbout = parseKnowsAbout(author.expertise);
  const sameAs = parseSameAs(author.same_as);
  const url = `${siteUrl}${authorPath(author.slug)}`;
  const absolutize = (u: string) =>
    /^https?:\/\//i.test(u) ? u : siteUrl ? `${siteUrl}${u.startsWith("/") ? "" : "/"}${u}` : u;

  // ProfilePage + Person + BreadcrumbList (+ ItemList of the page's posts) — the
  // durable Person @id matches each article's `author` ref.
  const personNode: Record<string, unknown> = {
    "@type": "Person",
    "@id": authorPersonId(siteUrl, author.slug),
    name: author.name,
    url,
    ...(author.job_title ? { jobTitle: author.job_title } : {}),
    ...(author.bio ? { description: author.bio } : {}),
    ...(knowsAbout.length ? { knowsAbout } : {}),
    ...(sameAs.length ? { sameAs } : {}),
    ...(avatarUrl ? { image: absolutize(avatarUrl) } : {}),
  };
  const jsonLd = siteUrl
    ? {
        "@context": "https://schema.org",
        "@graph": [
          {
            "@type": "ProfilePage",
            "@id": `${url}#webpage`,
            url,
            name: author.meta_title?.trim() || author.name,
            isPartOf: { "@type": "WebSite", "@id": websiteId(siteUrl), url: siteUrl, name: siteName },
            mainEntity: { "@id": personNode["@id"] },
          },
          personNode,
          {
            "@type": "BreadcrumbList",
            "@id": `${url}#breadcrumb`,
            itemListElement: [
              { "@type": "ListItem", position: 1, name: "Accueil", item: `${siteUrl}/` },
              { "@type": "ListItem", position: 2, name: "Blog", item: `${siteUrl}/blog` },
              { "@type": "ListItem", position: 3, name: author.name, item: url },
            ],
          },
          ...(posts.length
            ? [
                {
                  "@type": "ItemList",
                  "@id": `${url}#articles`,
                  itemListElement: posts.map((p, i) => ({
                    "@type": "ListItem",
                    position: i + 1,
                    url: `${siteUrl}/blog/${p.slug}`,
                  })),
                },
              ]
            : []),
        ],
      }
    : null;
  const jsonLdHtml = jsonLd ? JSON.stringify(jsonLd).replace(/</g, "\\u003c") : null;

  return (
    <>
      {jsonLdHtml && (
        <script
          type="application/ld+json"
          // eslint-disable-next-line react/no-danger
          dangerouslySetInnerHTML={{ __html: jsonLdHtml }}
        />
      )}
      <BlogAuthorView
        profile={{
          name: author.name,
          jobTitle: author.job_title,
          bio: author.bio,
          avatarUrl,
          initials: initialsOf(author.name),
          color: colorFor(author.slug),
          sinceYear: author.created_at ? new Date(author.created_at).getFullYear() : null,
          tags: knowsAbout,
          socials: sameAs.map(mapSocial),
        }}
        stats={{
          count: stats.total,
          minutes: stats.totalMinutes,
          topCategory: stats.categories[0]?.name ?? null,
          lastIso: stats.lastPublishedAt ? new Date(stats.lastPublishedAt).toISOString() : null,
        }}
        posts={posts}
        total={total}
        page={page}
        pageSize={PAGE_SIZE}
        categories={stats.categories}
        activeCatSlug={cat}
        basePath={authorPath(author.slug)}
        team={others.map((o) => ({
          slug: o.slug,
          name: o.name,
          jobTitle: o.jobTitle,
          avatarUrl: o.avatarUrl,
          initials: initialsOf(o.name),
          color: colorFor(o.slug),
          count: o.count,
        }))}
      />
    </>
  );
}
