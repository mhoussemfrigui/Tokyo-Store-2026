import Link from "next/link";
import { ArrowRight, Check, ChevronRight, Clock, Home } from "lucide-react";

import { cn } from "@/storefront/lib/utils";
import { BlogCard, type BlogCardData, formatBlogDate } from "./blog-card";

/** A resolved social link chip (mapped from the author's sameAs at the page). */
export type AuthorSocial = { href: string; label: string; code: string; bg: string };

/** The author profile header data (serializable — computed server-side). */
export type AuthorProfile = {
  name: string;
  jobTitle: string | null;
  bio: string | null;
  avatarUrl: string | null;
  initials: string;
  /** Avatar fallback background (stable per author). */
  color: string;
  /** created_at year → « Auteur depuis YYYY ». */
  sinceYear: number | null;
  /** knowsAbout → expertise chips. */
  tags: string[];
  socials: AuthorSocial[];
};

export type AuthorStatsView = {
  count: number;
  minutes: number;
  topCategory: string | null;
  /** ISO of the last published post (for « dernier article »). */
  lastIso: string | null;
};

export type AuthorArchiveCategory = { slug: string; name: string; count: number };
export type AuthorTeamMember = {
  slug: string;
  name: string;
  jobTitle: string | null;
  avatarUrl: string | null;
  initials: string;
  color: string;
  count: number;
};

export type BlogAuthorViewProps = {
  profile: AuthorProfile;
  stats: AuthorStatsView;
  posts: BlogCardData[];
  total: number;
  page: number;
  pageSize: number;
  categories: AuthorArchiveCategory[];
  /** "" = the « Tous » chip is active, else the active category slug. */
  activeCatSlug: string;
  /** The author archive path, e.g. /auteur/jean-dupont. */
  basePath: string;
  team: AuthorTeamMember[];
};

/** basePath + ?cat/?page, omitting defaults. */
function archiveHref(basePath: string, params: { cat?: string; page?: number }): string {
  const sp = new URLSearchParams();
  if (params.cat) sp.set("cat", params.cat);
  if (params.page && params.page > 1) sp.set("page", String(params.page));
  const qs = sp.toString();
  return qs ? `${basePath}?${qs}` : basePath;
}

/** Numbered page set with ellipses: 1 … p-1 p p+1 … last. */
function pageList(page: number, pages: number): number[] {
  const set = [...new Set([1, pages, page - 1, page, page + 1].filter((n) => n >= 1 && n <= pages))].sort(
    (a, b) => a - b,
  );
  const out: number[] = [];
  set.forEach((n, i) => {
    if (i && n - set[i - 1]! > 1) out.push(-1);
    out.push(n);
  });
  return out;
}

export function BlogAuthorView(props: BlogAuthorViewProps) {
  const { profile, stats, posts, total, page, pageSize, categories, activeCatSlug, basePath, team } = props;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const shown = `${total} ${total > 1 ? "articles" : "article"}`;
  const lastLabel = formatBlogDate(stats.lastIso, "short");
  const allChips: AuthorArchiveCategory[] = [{ slug: "", name: "Tous", count: stats.count }, ...categories];

  return (
    <div className="page-container flex flex-col gap-5 pt-3">
      {/* ── Profile header ─────────────────────────────────────────────── */}
      <section className="flex flex-col gap-[clamp(22px,3vw,32px)] rounded-[36px] bg-card p-[clamp(24px,4vw,48px)]">
        <nav aria-label="Fil d'Ariane" className="flex items-center gap-1.5 overflow-hidden whitespace-nowrap text-[13px]">
          <Link href="/" aria-label="Accueil" className="grid size-[30px] shrink-0 place-items-center rounded-full bg-background text-foreground transition-colors hover:bg-primary/10 hover:text-primary">
            <Home aria-hidden className="size-3.5" strokeWidth={2} />
          </Link>
          <ChevronRight aria-hidden className="size-3 shrink-0 text-border" strokeWidth={2.4} />
          <Link href="/blog" className="px-0.5 py-1 text-muted-foreground transition-colors hover:text-primary">Blog</Link>
          <ChevronRight aria-hidden className="size-3 shrink-0 text-border" strokeWidth={2.4} />
          <span className="px-0.5 py-1 text-muted-foreground">Auteurs</span>
          <ChevronRight aria-hidden className="size-3 shrink-0 text-border" strokeWidth={2.4} />
          <span aria-current="page" className="truncate rounded-full bg-primary/10 px-3 py-1.5 font-semibold text-primary">{profile.name}</span>
        </nav>

        <div className="grid items-center gap-[clamp(20px,3vw,40px)] [grid-template-columns:repeat(auto-fit,minmax(min(100%,360px),1fr))]">
          {/* Avatar + identity */}
          <div className="flex flex-wrap items-center gap-[clamp(18px,2.4vw,28px)]">
            <span
              className="relative grid size-[clamp(104px,12vw,148px)] shrink-0 place-items-center rounded-full text-[clamp(36px,4.4vw,52px)] font-black tracking-[-0.03em] text-white shadow-[0_0_0_8px_var(--surface-beige)]"
              style={profile.avatarUrl ? undefined : { background: profile.color }}
            >
              {profile.avatarUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={profile.avatarUrl} alt={profile.name} className="absolute inset-0 size-full rounded-full object-cover" />
              ) : (
                profile.initials
              )}
              <span className="absolute bottom-1.5 right-0.5 grid size-[34px] place-items-center rounded-full border-4 border-card bg-[#16a34a]" aria-hidden>
                <Check className="size-3.5 text-white" strokeWidth={3} />
              </span>
            </span>
            <div className="flex min-w-0 flex-1 basis-[260px] flex-col gap-2.5">
              {profile.jobTitle && (
                <span className="text-[12px] font-extrabold uppercase tracking-[0.16em] text-primary">{profile.jobTitle}</span>
              )}
              <h1 className="m-0 text-[clamp(36px,5vw,64px)] font-black leading-[0.95] tracking-[-0.045em] text-balance">{profile.name}</h1>
              {profile.sinceYear && (
                <span className="flex flex-wrap items-center gap-x-3.5 gap-y-1.5 text-[14px] text-muted-foreground">
                  <span className="flex items-center gap-1.5">
                    <Clock aria-hidden className="size-4 shrink-0" strokeWidth={2.2} />
                    Auteur depuis {profile.sinceYear}
                  </span>
                </span>
              )}
            </div>
          </div>

          {/* Bio + tags + socials */}
          <div className="flex flex-col gap-[18px]">
            {profile.bio && <p className="m-0 text-[17px] leading-[1.65] text-graphite text-pretty">{profile.bio}</p>}
            {profile.tags.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {profile.tags.map((t) => (
                  <span key={t} className="inline-flex h-[34px] items-center rounded-full bg-primary/10 px-3.5 text-[13px] font-extrabold text-primary">{t}</span>
                ))}
              </div>
            )}
            {profile.socials.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {profile.socials.map((s) => (
                  <a
                    key={s.href}
                    href={s.href}
                    target="_blank"
                    rel="noopener noreferrer nofollow"
                    className="flex h-11 items-center gap-2 rounded-full border-[1.5px] border-border bg-card py-0 pl-1.5 pr-4 text-[14px] font-bold text-foreground transition-colors hover:border-foreground"
                  >
                    <span className="grid size-8 shrink-0 place-items-center rounded-full text-[11px] font-black text-white" style={{ background: s.bg }}>
                      {s.code}
                    </span>
                    {s.label}
                  </a>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Stats */}
        <div className="grid gap-2.5 [grid-template-columns:repeat(auto-fit,minmax(min(100%,150px),1fr))]">
          <StatCell value={String(stats.count)} label={stats.count > 1 ? "articles publiés" : "article publié"} />
          <StatCell value={String(stats.minutes)} label="minutes de lecture" />
          <StatCell value={stats.topCategory ?? "—"} label="rubrique principale" />
          <StatCell value={lastLabel || "—"} label="dernier article" />
        </div>
      </section>

      {/* ── Their articles ─────────────────────────────────────────────── */}
      <section className="flex flex-col gap-4">
        <div className="flex min-h-16 flex-wrap items-center justify-between gap-3 rounded-[24px] bg-card py-2 pl-5 pr-2">
          <span className="text-[15px] font-bold">
            Ses articles <span className="font-semibold text-muted-foreground">· {shown}</span>
          </span>
          {allChips.length > 1 && (
            <div className="-mx-1 flex max-w-full gap-1.5 overflow-x-auto px-1 [scrollbar-width:none]">
              {allChips.map((c) => {
                const on = c.slug === activeCatSlug;
                return (
                  <Link
                    key={c.slug || "all"}
                    href={archiveHref(basePath, { cat: c.slug })}
                    aria-current={on ? "true" : undefined}
                    className={cn(
                      "flex h-10 shrink-0 items-center whitespace-nowrap rounded-full border-[1.5px] px-4 text-[13px] font-bold transition-colors",
                      on ? "border-foreground bg-foreground text-background" : "border-border bg-card text-foreground hover:border-foreground",
                    )}
                  >
                    {c.name} · {c.count}
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
            <span className="text-[20px] font-extrabold">Aucun article</span>
            <span className="text-[15px] text-muted-foreground">
              {activeCatSlug ? "Aucun article dans cette rubrique." : "Cet auteur n'a pas encore publié d'article."}
            </span>
            {activeCatSlug && (
              <Link href={basePath} className="mt-1 flex h-12 items-center rounded-full bg-foreground px-[22px] text-[14px] font-bold text-background">
                Voir tous ses articles
              </Link>
            )}
          </div>
        )}

        {pages > 1 && (
          <nav aria-label="Pagination" className="mt-2 flex items-center justify-center gap-2">
            <CircleNav href={archiveHref(basePath, { cat: activeCatSlug, page: page - 1 })} disabled={page <= 1} dir="prev" />
            <div className="flex items-center gap-1 rounded-full bg-card p-1">
              {pageList(page, pages).map((n, i) =>
                n < 0 ? (
                  <span key={`e${i}`} className="grid h-10 min-w-[40px] place-items-center text-[14px] font-extrabold text-muted-foreground">…</span>
                ) : (
                  <Link
                    key={n}
                    href={archiveHref(basePath, { cat: activeCatSlug, page: n })}
                    aria-current={n === page ? "page" : undefined}
                    className={cn(
                      "grid h-10 min-w-[40px] place-items-center rounded-full px-2 text-[14px] font-extrabold tabular-nums transition-colors",
                      n === page ? "bg-foreground text-background" : "text-foreground hover:bg-background",
                    )}
                  >
                    {n}
                  </Link>
                ),
              )}
            </div>
            <CircleNav href={archiveHref(basePath, { cat: activeCatSlug, page: page + 1 })} disabled={page >= pages} dir="next" />
          </nav>
        )}
      </section>

      {/* ── Other authors ──────────────────────────────────────────────── */}
      {team.length > 0 && (
        <section className="flex flex-col gap-5 rounded-[36px] bg-card p-[clamp(22px,3.4vw,40px)]">
          <div className="flex flex-col gap-2">
            <span className="text-[12px] font-extrabold uppercase tracking-[0.16em] text-primary">L&apos;équipe éditoriale</span>
            <h2 className="m-0 text-[clamp(26px,3vw,36px)] font-black leading-[1.05] tracking-[-0.035em] text-balance">Nos autres auteurs</h2>
          </div>
          <div className="grid gap-2.5 [grid-template-columns:repeat(auto-fit,minmax(min(100%,240px),1fr))]">
            {team.map((m) => (
              <Link
                key={m.slug}
                href={`/auteur/${m.slug}`}
                className="flex items-center gap-3.5 rounded-[24px] border-[1.5px] border-border bg-background p-3 pr-4 text-foreground transition-[border-color,transform] duration-300 hover:-translate-y-0.5 hover:border-foreground"
              >
                <span className="grid size-[52px] shrink-0 place-items-center overflow-hidden rounded-full text-[16px] font-black text-white" style={m.avatarUrl ? undefined : { background: m.color }}>
                  {m.avatarUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={m.avatarUrl} alt={m.name} className="size-full object-cover" />
                  ) : (
                    m.initials
                  )}
                </span>
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="truncate text-[15px] font-extrabold">{m.name}</span>
                  <span className="truncate text-[13px] text-muted-foreground">
                    {[m.jobTitle, `${m.count} article${m.count > 1 ? "s" : ""}`].filter(Boolean).join(" · ")}
                  </span>
                </span>
              </Link>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function StatCell({ value, label }: { value: string; label: string }) {
  return (
    <span className="flex min-w-0 flex-col gap-1 rounded-[22px] bg-background px-[18px] py-4">
      <span className="truncate text-[clamp(24px,2.6vw,32px)] font-black leading-none tracking-[-0.03em] tabular-nums">{value}</span>
      <span className="text-[13px] font-semibold text-muted-foreground">{label}</span>
    </span>
  );
}

/** A 48px circular icon-only prev/next control (the mockup's author pager nav). */
function CircleNav({ href, disabled, dir }: { href: string; disabled: boolean; dir: "prev" | "next" }) {
  const icon = <ArrowRight aria-hidden className={cn("size-4", dir === "prev" && "rotate-180")} strokeWidth={2.2} />;
  const cls = "grid size-12 shrink-0 place-items-center rounded-full border-[1.5px] border-border bg-card text-foreground transition-colors hover:border-foreground";
  if (disabled) {
    return (
      <span aria-disabled className={cn(cls, "pointer-events-none opacity-35")}>
        {icon}
      </span>
    );
  }
  return (
    <Link href={href} aria-label={dir === "prev" ? "Page précédente" : "Page suivante"} className={cls}>
      {icon}
    </Link>
  );
}
