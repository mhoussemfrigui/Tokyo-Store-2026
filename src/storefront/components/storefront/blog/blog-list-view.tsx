import Link from "next/link";
import { ArrowRight, ChevronRight, Home } from "lucide-react";

import { cn } from "@/storefront/lib/utils";
import { BlogCard, type BlogCardData, formatBlogDate, readingLabel } from "./blog-card";
import { BlogSearch } from "./blog-search";

export type BlogListCategory = { slug: string; name: string; count: number };
export type BlogFeatured = BlogCardData & { authorName: string | null; authorInitials: string };

export type BlogListMode = "all" | "category" | "tag" | "search";

export type BlogListViewProps = {
  mode: BlogListMode;
  /** Page <h1>. */
  title: string;
  lede: string;
  aboutTitle: string;
  aboutText: string;
  /** Category chips + the total-articles count (for the « Tous » chip). */
  categories: BlogListCategory[];
  totalAll: number;
  /** "" = the « Tous » chip is active; else the active category slug. */
  activeCatSlug: string;
  /** Tag/search breadcrumb label (shown after « Blog »); empty for all/category. */
  crumbLabel: string;
  featured: BlogFeatured | null;
  posts: BlogCardData[];
  total: number;
  page: number;
  pageSize: number;
  sort: "recent" | "popular";
  q: string;
  /** The surface's own path: /blog, /blog/<cat>, or /blog/tag/<slug>. */
  basePath: string;
};

/** Build a query string onto basePath, preserving sort/q, omitting defaults. */
function href(basePath: string, params: { sort?: string; q?: string; page?: number }) {
  const sp = new URLSearchParams();
  if (params.q) sp.set("q", params.q);
  if (params.sort && params.sort !== "recent") sp.set("sort", params.sort);
  if (params.page && params.page > 1) sp.set("page", String(params.page));
  const qs = sp.toString();
  return qs ? `${basePath}?${qs}` : basePath;
}

/** The numbered page set with ellipses: 1 … p-1 p p+1 … last. */
function pageList(page: number, pages: number): number[] {
  const set = [...new Set([1, pages, page - 1, page, page + 1].filter((n) => n >= 1 && n <= pages))].sort(
    (a, b) => a - b,
  );
  const out: number[] = [];
  set.forEach((n, i) => {
    if (i && n - set[i - 1]! > 1) out.push(-1); // ellipsis marker
    out.push(n);
  });
  return out;
}

export function BlogListView(props: BlogListViewProps) {
  const {
    mode, title, lede, aboutTitle, aboutText, categories, totalAll, activeCatSlug,
    crumbLabel, featured, posts, total, page, pageSize, sort, q, basePath,
  } = props;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const countLabel = `${total} ${total > 1 ? "articles" : "article"}`;
  const isSearch = mode === "search";

  return (
    <div className="page-container flex flex-col gap-5 pt-3">
      {/* Category header card */}
      <section className="flex flex-col gap-7 rounded-[clamp(24px,4vw,36px)] bg-card p-[clamp(24px,4vw,48px)]">
        <nav aria-label="Fil d'Ariane" className="flex items-center gap-1.5 overflow-hidden whitespace-nowrap text-[13px]">
          <Link href="/" aria-label="Accueil" className="grid size-[30px] shrink-0 place-items-center rounded-full bg-background text-foreground transition-colors hover:bg-primary/10 hover:text-primary">
            <Home aria-hidden className="size-3.5" strokeWidth={2} />
          </Link>
          <ChevronRight aria-hidden className="size-3 shrink-0 text-border" strokeWidth={2.4} />
          {crumbLabel ? (
            <Link href="/blog" className="px-0.5 py-1 text-muted-foreground transition-colors hover:text-primary">Blog</Link>
          ) : (
            <span aria-current="page" className="rounded-full bg-primary/10 px-3 py-1.5 font-semibold text-primary">Blog</span>
          )}
          {crumbLabel && (
            <>
              <ChevronRight aria-hidden className="size-3 shrink-0 text-border" strokeWidth={2.4} />
              <span aria-current="page" className="truncate rounded-full bg-primary/10 px-3 py-1.5 font-semibold text-primary">{crumbLabel}</span>
            </>
          )}
        </nav>

        <div className="flex flex-wrap items-end justify-between gap-x-12 gap-y-5">
          <div className="flex min-w-0 flex-1 basis-[520px] flex-col gap-3.5">
            <h1 className="m-0 text-[clamp(44px,6.5vw,96px)] font-black leading-[0.92] tracking-[-0.05em] text-balance">{title}</h1>
            {lede && <p className="m-0 max-w-[60ch] text-[17px] leading-[1.6] text-graphite text-pretty">{lede}</p>}
          </div>
          <BlogSearch defaultValue={q} />
        </div>

        {/* Category chips */}
        {categories.length > 0 && (
          <div className="-mx-1 flex gap-2 overflow-x-auto px-1 py-0.5 [mask-image:linear-gradient(90deg,#000_calc(100%-32px),transparent)] [scrollbar-width:none]">
            {categories.map((c) => {
              const on = c.slug === activeCatSlug && !isSearch;
              const chipHref = c.slug === "" ? "/blog" : `/blog/${c.slug}`;
              return (
                <Link
                  key={c.slug || "all"}
                  href={chipHref}
                  aria-current={on ? "page" : undefined}
                  className={cn(
                    "flex h-11 shrink-0 items-center gap-2 whitespace-nowrap rounded-full border-[1.5px] pl-[18px] pr-2 text-[14px] font-bold transition-colors",
                    on ? "border-foreground bg-foreground text-background" : "border-border bg-card text-foreground hover:border-foreground",
                  )}
                >
                  {c.name}
                  <span className={cn("grid h-7 min-w-[28px] place-items-center rounded-full px-2 text-[12px] font-extrabold", on ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground")}>
                    {c.slug === "" ? totalAll : c.count}
                  </span>
                </Link>
              );
            })}
          </div>
        )}
      </section>

      {/* Featured « À la une » */}
      {featured && (
        <Link href={`/blog/${featured.slug}`} className="group grid overflow-hidden rounded-[36px] bg-foreground text-background min-[380px]:min-h-[clamp(320px,38vw,460px)] md:grid-cols-2">
          <span className="relative m-3 block min-h-[260px] overflow-hidden rounded-[28px] bg-card">
            {featured.imageUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={featured.imageUrl} alt={featured.imageAlt || ""} loading="lazy" decoding="async" className="absolute inset-[10%] size-[80%] object-contain transition-transform duration-500 group-hover:scale-[1.03]" />
            )}
          </span>
          <span className="flex flex-col justify-center gap-[18px] p-[clamp(22px,4vw,52px)]">
            <span className="flex flex-wrap gap-2">
              <span className="inline-flex h-7 w-max items-center rounded-full bg-primary px-3 text-[12px] font-extrabold tracking-[0.04em] text-primary-foreground">À la une</span>
              {featured.categoryName && <span className="inline-flex h-7 w-max items-center rounded-full bg-white/10 px-3 text-[12px] font-extrabold">{featured.categoryName}</span>}
            </span>
            <span className="text-[clamp(28px,3.4vw,48px)] font-black leading-[1.02] tracking-[-0.04em] text-balance">{featured.title}</span>
            {featured.excerpt && <span className="max-w-[52ch] text-[16px] leading-[1.6] text-background/75">{featured.excerpt}</span>}
            <span className="mt-1.5 flex flex-wrap items-center justify-between gap-3.5">
              <span className="flex items-center gap-2.5 text-[14px] text-background/75">
                <span className="grid size-9 place-items-center rounded-full bg-primary text-[13px] font-extrabold text-primary-foreground">{featured.authorInitials}</span>
                <span className="flex flex-col">
                  {featured.authorName && <span className="font-bold text-background">{featured.authorName}</span>}
                  <span>{[formatBlogDate(featured.publishedAt, "short"), readingLabel(featured.readingMinutes)].filter(Boolean).join(" · ")}</span>
                </span>
              </span>
              <span className="inline-flex h-[52px] items-center gap-2.5 rounded-full bg-card px-[22px] text-[15px] font-bold text-foreground">
                Lire l&apos;article
                <ArrowRight aria-hidden className="size-4" strokeWidth={2} />
              </span>
            </span>
          </span>
        </Link>
      )}

      {/* Toolbar + grid + pagination */}
      <section className="flex flex-col gap-4">
        <div className="flex min-h-16 flex-wrap items-center justify-between gap-2.5 rounded-[24px] bg-card py-2 pl-5 pr-2">
          <span className="text-[15px] font-bold">{isSearch ? `Résultats pour « ${q} »` : countLabel}</span>
          {!isSearch && (
            <div className="grid grid-cols-2 gap-1 rounded-full bg-background p-1">
              {(["recent", "popular"] as const).map((s) => {
                const on = sort === s;
                return (
                  <Link
                    key={s}
                    href={href(basePath, { sort: s, q })}
                    aria-current={on ? "true" : undefined}
                    className={cn("flex h-10 items-center justify-center rounded-full px-[18px] text-[14px] font-bold transition-colors", on ? "bg-card text-foreground shadow-[0_4px_14px_rgba(14,18,24,0.08)]" : "text-muted-foreground")}
                  >
                    {s === "recent" ? "Récents" : "Populaires"}
                  </Link>
                );
              })}
            </div>
          )}
        </div>

        {posts.length > 0 ? (
          <div className="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(min(100%,260px),1fr))]">
            {posts.map((p) => (
              <BlogCard key={p.slug} post={p} />
            ))}
          </div>
        ) : (
          <div className="flex flex-col items-center gap-3 rounded-[32px] bg-card p-10 text-center">
            <span className="text-[20px] font-extrabold">Aucun article trouvé</span>
            <span className="text-[15px] text-muted-foreground">Essayez un autre mot-clé ou une autre catégorie.</span>
            <Link href="/blog" className="mt-1 flex h-12 items-center rounded-full bg-foreground px-[22px] text-[14px] font-bold text-background">Voir tous les articles</Link>
          </div>
        )}

        {pages > 1 && (
          <>
            <nav aria-label="Pagination" className="mt-4 grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 rounded-full bg-card p-2">
              <PagerButton href={href(basePath, { sort, q, page: page - 1 })} disabled={page <= 1} dir="prev" />
              <div className="flex min-w-0 flex-col items-center gap-2">
                <div className="flex items-center gap-1 rounded-full bg-background p-1">
                  {pageList(page, pages).map((n, i) =>
                    n < 0 ? (
                      <span key={`e${i}`} className="grid h-10 min-w-[40px] place-items-center text-[14px] font-extrabold text-muted-foreground">…</span>
                    ) : (
                      <Link
                        key={n}
                        href={href(basePath, { sort, q, page: n })}
                        aria-current={n === page ? "page" : undefined}
                        className={cn("grid h-10 min-w-[40px] place-items-center rounded-full px-2 text-[14px] font-extrabold tabular-nums transition-colors", n === page ? "bg-card text-primary shadow-[0_4px_14px_rgba(14,18,24,0.1)]" : "text-graphite hover:text-foreground")}
                      >
                        {n}
                      </Link>
                    ),
                  )}
                </div>
              </div>
              <PagerButton href={href(basePath, { sort, q, page: page + 1 })} disabled={page >= pages} dir="next" />
            </nav>
            <div className="flex flex-col items-center gap-2.5 pb-1 pt-1.5">
              <span className="text-[13px] tabular-nums text-muted-foreground">
                Articles {(page - 1) * pageSize + 1}–{Math.min(page * pageSize, total)} sur {total}
              </span>
              <span className="flex h-1 w-[min(220px,60%)] overflow-hidden rounded-full bg-[#ece6df]">
                <span className="rounded-full bg-primary transition-[width]" style={{ width: `${Math.round((page / pages) * 100)}%` }} />
              </span>
            </div>
          </>
        )}
      </section>

      {/* « À propos du blog » */}
      {mode !== "search" && aboutText && (
        <section className="grid gap-x-12 gap-y-6 rounded-[36px] bg-card p-[clamp(22px,3.4vw,44px)] [grid-template-columns:repeat(auto-fit,minmax(min(100%,320px),1fr))]">
          <div className="flex flex-col gap-3">
            <span className="text-[12px] font-extrabold uppercase tracking-[0.16em] text-primary">Le blog Tokyo Store</span>
            <h2 className="m-0 text-[clamp(26px,3vw,38px)] font-black leading-[1.05] tracking-[-0.035em] text-balance">{aboutTitle}</h2>
          </div>
          <p className="m-0 text-[16px] leading-[1.7] text-graphite text-pretty">{aboutText}</p>
        </section>
      )}
    </div>
  );
}

function PagerButton({ href: h, disabled, dir }: { href: string; disabled: boolean; dir: "prev" | "next" }) {
  const label = dir === "prev" ? "Précédent" : "Suivant";
  const cls = "flex h-[52px] items-center justify-center gap-2.5 whitespace-nowrap rounded-full border-[1.5px] border-border bg-card px-4 text-[15px] font-bold text-foreground transition-colors hover:border-foreground sm:px-[22px]";
  const icon =
    dir === "prev" ? (
      <ArrowRight aria-hidden className="size-4 rotate-180" strokeWidth={2.4} />
    ) : (
      <ArrowRight aria-hidden className="size-4" strokeWidth={2.4} />
    );
  if (disabled) {
    return (
      <span aria-disabled className={cn(cls, "pointer-events-none opacity-35")}>
        {dir === "prev" && icon}
        <span className="hidden sm:inline">{label}</span>
        {dir === "next" && icon}
      </span>
    );
  }
  return (
    <Link href={h} aria-label={dir === "prev" ? "Page précédente" : "Page suivante"} className={cls}>
      {dir === "prev" && icon}
      <span className="hidden sm:inline">{label}</span>
      {dir === "next" && icon}
    </Link>
  );
}
