import Link from "next/link";
import { ArrowLeft, ArrowRight, Search } from "lucide-react";

import { TokyoFace } from "@/components/tokyo-face";

/** Recovery links — FIXED storefront routes that always render (never a data-
 *  dependent category slug, which could itself 404). Guarded by
 *  storefront-chrome.test.ts (every href must be a real storefront route). */
const QUICK_LINKS: ReadonlyArray<{ label: string; href: string }> = [
  { label: "Recherche", href: "/recherche" },
  { label: "Reels", href: "/reels" },
  { label: "Nos boutiques", href: "/apropos#boutiques" },
  { label: "Journal", href: "/blog" },
];

/**
 * Custom 404 — the crimson Tokyo scene (replaces the olive clock version). A full
 * white card on the beige canvas with a "4 · [mascot face] · 4" lockup: the face
 * (see {@link TokyoFace}) follows the cursor and blinks, carrying a crimson "?"
 * badge. Self-contained recovery — a no-JS search box (→ /recherche) and
 * fixed-route quick links — so it NEVER needs the storefront header/footer and
 * works even when hydration fails.
 *
 * Both 404 boundaries render it chrome-free: the root `app/not-found.tsx` for
 * truly top-level misses, and `(shop)/not-found.tsx` for storefront misses (the
 * thin `(shop)/layout.tsx` discards the `(shell)` chrome). Copy + the
 * `showSearch` / `showSuggestions` toggles come from the admin 404 settings.
 */
export function NotFoundScene({
  embedded = false,
  title,
  message,
  showSearch = true,
  showSuggestions = true,
  logoUrl,
}: {
  embedded?: boolean;
  title: string;
  message: string;
  showSearch: boolean;
  showSuggestions: boolean;
  /** Médiathèque logo → falls back to the bundled mark. */
  logoUrl?: string | null;
}) {
  const logoSrc = logoUrl?.trim() || "/tokyo-logo.png";
  return (
    <div className={`tokyo flex box-border bg-[#f6f2ed] p-3 ${embedded ? "min-h-[60vh]" : "min-h-[100dvh]"}`}>
      <main
        className="relative flex flex-1 flex-col items-center justify-center gap-[clamp(24px,3vw,36px)] overflow-hidden rounded-[36px] bg-white px-[clamp(20px,4vw,56px)] py-[clamp(28px,5vw,64px)] text-center font-sans text-[#0e1218]"
      >
        {/* Keep a 404 out of the index — React 19 hoists this into <head>. */}
        <meta name="robots" content="noindex,follow" />

        {/* Logo, top-left. */}
        <Link
          href="/"
          aria-label="Tokyo Store, accueil"
          className="absolute left-[clamp(16px,3vw,32px)] top-[clamp(16px,3vw,32px)] flex items-center gap-2.5"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={logoSrc} alt="" width={44} height={44} className="h-11 w-11 rounded-full object-cover" />
        </Link>

        {/* Eyebrow pill. */}
        <span className="inline-flex h-[34px] items-center gap-2 rounded-full bg-[#f9dde2] px-3.5 text-[13px] font-extrabold tracking-[.06em] text-[#b80329]">
          Erreur 404
        </span>

        {/* 4 · face · 4 lockup. */}
        <div
          aria-hidden
          className="tk-fade-in-up flex items-center justify-center gap-[clamp(4px,1.2vw,16px)]"
          style={{ animationDelay: "0.06s" }}
        >
          <span className="text-[clamp(96px,24vw,340px)] font-black leading-[.8] tracking-[-.08em] text-[#0e1218]">4</span>
          <TokyoFace badge="question" className="h-[clamp(104px,21vw,300px)] w-[clamp(104px,21vw,300px)]" />
          <span className="text-[clamp(96px,24vw,340px)] font-black leading-[.8] tracking-[-.08em] text-[#0e1218]">4</span>
        </div>

        {/* Copy. */}
        <div className="flex max-w-[620px] flex-col items-center gap-3">
          <h1 className="m-0 text-[clamp(28px,3.6vw,48px)] font-black leading-[1.04] tracking-[-.04em] text-balance">
            {title}
          </h1>
          <p className="m-0 text-[17px] leading-[1.6] text-[#3d4046] text-pretty">{message}</p>
        </div>

        {/* No-JS recovery search → the storefront search page. */}
        {showSearch && (
          <form action="/recherche" role="search" className="flex h-16 w-full max-w-[620px] items-center gap-2 rounded-full border-[1.5px] border-[#e6dfd7] bg-[#fbf9f8] py-1.5 pl-[22px] pr-1.5 transition-colors focus-within:border-[#0e1218] focus-within:bg-white">
            <Search className="h-5 w-5 shrink-0 text-[#5b5d62]" strokeWidth={2} aria-hidden />
            <label htmlFor="nf-q" className="sr-only">
              Que cherchiez-vous ?
            </label>
            <input
              id="nf-q"
              name="q"
              type="search"
              autoComplete="off"
              placeholder="Que cherchiez-vous ?"
              className="min-w-0 flex-1 border-none bg-transparent text-[16px] text-[#0e1218] outline-none placeholder:text-[#5b5d62]"
            />
            <button
              type="submit"
              className="inline-flex h-[52px] shrink-0 items-center gap-2 rounded-full bg-[#d40530] px-4 text-[15px] font-bold text-white transition hover:brightness-[.92] min-[520px]:px-[22px]"
            >
              <span className="hidden min-[520px]:inline">Rechercher</span>
              <ArrowRight className="h-4 w-4 shrink-0" strokeWidth={2.2} aria-hidden />
            </button>
          </form>
        )}

        {/* Fixed-route quick links. */}
        {showSuggestions && (
          <nav aria-label="Liens rapides" className="flex max-w-[720px] flex-wrap items-center justify-center gap-2">
            {QUICK_LINKS.map((l) => (
              <Link
                key={l.href}
                href={l.href}
                className="flex h-11 items-center rounded-full border-[1.5px] border-[#e6dfd7] bg-white px-[18px] text-[14px] font-bold text-[#0e1218] transition-colors hover:border-[#d40530] hover:bg-[#f9dde2] hover:text-[#d40530]"
              >
                {l.label}
              </Link>
            ))}
          </nav>
        )}

        {/* Primary CTA. */}
        <Link
          href="/"
          className="inline-flex h-[52px] items-center gap-2.5 rounded-full bg-[#0e1218] px-6 text-[15px] font-bold text-white transition-colors hover:bg-[#2a2e35]"
        >
          <ArrowLeft className="h-4 w-4" strokeWidth={2.2} aria-hidden />
          Retour à l&apos;accueil
        </Link>
      </main>
    </div>
  );
}
