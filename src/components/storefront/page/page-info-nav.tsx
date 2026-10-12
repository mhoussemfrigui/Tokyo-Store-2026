import type { CSSProperties } from "react";
import Link from "next/link";
import { ArrowRight } from "lucide-react";

import { SECTION_CONTAINER } from "@/lib/pages/block-model";
import type { MaisonExploreNav } from "@/lib/api/cms";

/**
 * « L'Index de la Maison » — the editorial table of contents shown at the foot
 * of the Maison & legal content pages (LegalPageRenderer routes, the system CMS
 * pages served by /[slug], /help). Purely presentational: the content comes
 * from the `maison-explore` nav menu (CMS → Footer) via `getMaisonExploreNav()`
 * — eyebrow = menu description, title = menu name, rows = its links + hints.
 *
 * Layout: a sticky title column (eyebrow, heading, brand tagline, contact link)
 * beside a two-column numbered index read top-to-bottom like a contents page.
 * The CURRENT page stays in the index (so it never changes shape from page to
 * page) as a non-link « Vous êtes ici » row. Hidden when the menu has no link.
 */

/** Path equality for the « you are here » row (query / hash / trailing slash ignored). */
function isCurrent(href: string, currentPath: string | undefined): boolean {
  if (!currentPath || !href.startsWith("/")) return false;
  const norm = (p: string) => (p.split(/[?#]/)[0].replace(/\/+$/, "") || "/").toLowerCase();
  return norm(href) === norm(currentPath);
}

export function PageInfoNav({
  nav,
  currentPath,
}: {
  nav: MaisonExploreNav;
  /** The page being viewed (e.g. `/cgv`) — rendered as « Vous êtes ici ». */
  currentPath?: string;
}) {
  const { links } = nav;
  if (links.length === 0) return null;
  // Column-major order on md+: the first half runs down the left column, the
  // rest down the right one — read like a table of contents (01→05, 06→09).
  const indexStyle = { "--index-rows": Math.ceil(links.length / 2) } as CSSProperties;
  const onHelp = isCurrent("/help", currentPath);

  return (
    <nav aria-label={nav.title} className="tk-page w-full border-t border-border/60">
      <div className={`${SECTION_CONTAINER} py-16 sm:py-20`}>
        <div className="grid gap-y-12 lg:grid-cols-12 lg:gap-x-10">
          {/* ── Title column ─────────────────────────────────────────────── */}
          <div className="lg:sticky lg:top-28 lg:col-span-4 lg:self-start">
            {nav.eyebrow && (
              <p className="font-body text-[0.65rem] uppercase tracking-[0.3em] text-olive">
                {nav.eyebrow}
              </p>
            )}
            <h2 className="mt-4 font-serif text-3xl font-normal tracking-tight text-foreground md:text-4xl">
              {nav.title}
            </h2>
            <span aria-hidden className="mt-6 block h-px w-12 bg-gold/70" />
            {nav.tagline && (
              <p className="mt-6 max-w-xs font-serif text-base italic leading-relaxed text-muted-foreground">
                {nav.tagline}
              </p>
            )}
            {!onHelp && (
              <Link
                href="/help"
                className="group mt-8 inline-flex items-center gap-2 font-body text-[0.7rem] uppercase tracking-[0.2em] text-foreground transition-colors duration-300 hover:text-olive focus-visible:text-olive focus-visible:outline-1 focus-visible:outline-offset-4 focus-visible:outline-olive/60"
              >
                Nous contacter
                <ArrowRight
                  aria-hidden
                  className="h-3.5 w-3.5 transition-[translate] duration-500 ease-out group-hover:translate-x-1 group-focus-visible:translate-x-1"
                  strokeWidth={1.6}
                />
              </Link>
            )}
          </div>

          {/* ── The index ────────────────────────────────────────────────── */}
          <ol
            style={indexStyle}
            className="grid grid-cols-1 md:grid-flow-col md:grid-cols-2 md:gap-x-10 md:[grid-template-rows:repeat(var(--index-rows),auto)] lg:col-span-8 lg:col-start-5"
          >
            {links.map((link, i) => {
              const n = String(i + 1).padStart(2, "0");
              if (isCurrent(link.href, currentPath)) {
                return (
                  <li key={`${link.href}-${i}`}>
                    <div
                      aria-current="page"
                      className="relative flex items-baseline gap-4 border-b border-border/60 py-4"
                    >
                      <span className="w-6 shrink-0 font-body text-[0.65rem] tabular-nums text-olive">
                        {n}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-2.5 font-serif text-lg tracking-tight text-foreground md:text-xl">
                          <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-olive" />
                          {link.label}
                        </span>
                        <span className="mt-1 block font-body text-[0.68rem] uppercase tracking-[0.14em] text-olive">
                          Vous êtes ici
                        </span>
                      </span>
                    </div>
                  </li>
                );
              }
              return (
                <li key={`${link.href}-${i}`}>
                  <Link
                    href={link.href}
                    {...(link.newTab ? { target: "_blank", rel: "noopener noreferrer" } : {})}
                    className="group relative flex items-baseline gap-4 border-b border-border/60 py-4 focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-olive/60"
                  >
                    <span className="w-6 shrink-0 font-body text-[0.65rem] tabular-nums text-muted-foreground transition-colors duration-500 group-hover:text-olive group-focus-visible:text-olive">
                      {n}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block font-serif text-lg tracking-tight text-foreground transition-[translate] duration-500 ease-out group-hover:translate-x-1 group-focus-visible:translate-x-1 md:text-xl">
                        {link.label}
                      </span>
                      {link.hint && (
                        <span className="mt-1 block font-body text-[0.68rem] uppercase tracking-[0.14em] text-muted-foreground">
                          {link.hint}
                        </span>
                      )}
                    </span>
                    {/* Always shown on touch screens; revealed on hover / focus where a pointer can hover. */}
                    <ArrowRight
                      aria-hidden
                      className="h-4 w-4 shrink-0 self-center text-olive transition-[opacity,translate] duration-500 ease-out group-hover:translate-x-0 group-hover:opacity-100 group-focus-visible:translate-x-0 group-focus-visible:opacity-100 [@media(hover:hover)]:-translate-x-2 [@media(hover:hover)]:opacity-0"
                      strokeWidth={1.6}
                    />
                    {/* Gold hairline drawn from the left over the row rule. */}
                    <span
                      aria-hidden
                      className="pointer-events-none absolute inset-x-0 -bottom-px h-px origin-left scale-x-0 bg-gold/70 transition-[scale] duration-500 ease-out group-hover:scale-x-100 group-focus-visible:scale-x-100"
                    />
                  </Link>
                </li>
              );
            })}
          </ol>
        </div>
      </div>
    </nav>
  );
}
