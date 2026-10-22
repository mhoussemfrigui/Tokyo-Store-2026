import type { ReactNode } from "react";
import Link from "next/link";
import { ChevronRight, Clock, Home, Phone } from "lucide-react";

import { telHref } from "@/lib/pages/page-blocks";
import { cn } from "@/storefront/lib/utils";
import {
  INFO_UPDATED,
  infoGroupLabel,
  infoNavModel,
  infoPage,
  isLegalInfoPage,
} from "./info-registry";
import { INFO_LEDE } from "./info-kit";
import { PrintButton } from "./print-button";

/**
 * The info-pages chrome (the X-Pages mockup): a white hero card (breadcrumb +
 * big title + lede, plus the legal « mise à jour » pill + Imprimer), then a grid
 * of the grouped side-nav (sticky desktop / horizontal-scroll mobile) + the
 * block-composed content column. Legal pages render the updated pill/print and a
 * Sommaire inside the legal_doc block itself.
 */
export function InfoPageShell({
  slug,
  title,
  lede,
  phone,
  children,
}: {
  slug: string;
  title: string;
  lede?: string | null;
  phone?: string | null;
  children: ReactNode;
}) {
  const entry = infoPage(slug);
  const groupLabel = entry ? infoGroupLabel(entry.group) : "";
  const legal = isLegalInfoPage(slug);
  const nav = infoNavModel(slug);
  // Real phone from « Identité & contact » (passed in by the page); no invented fallback.
  const tel = phone ? telHref(phone) : "";

  return (
    <div className="page-container flex flex-col gap-5 pt-3 sm:gap-5">
      {/* Hero */}
      <section className="relative overflow-hidden rounded-[clamp(24px,4vw,36px)] bg-card p-[clamp(24px,4vw,48px)] text-foreground">
        <nav aria-label="Fil d'Ariane" className="flex items-center gap-1.5 overflow-hidden whitespace-nowrap text-[13px]">
          <Link
            href="/"
            aria-label="Accueil"
            className="grid size-[30px] shrink-0 place-items-center rounded-full bg-background text-foreground transition-colors hover:bg-primary/10 hover:text-primary"
          >
            <Home aria-hidden className="size-3.5" strokeWidth={2} />
          </Link>
          {groupLabel && (
            <>
              <ChevronRight aria-hidden className="size-3 shrink-0 text-border" strokeWidth={2.4} />
              <span className="px-0.5 py-1 text-muted-foreground">{groupLabel}</span>
            </>
          )}
          <ChevronRight aria-hidden className="size-3 shrink-0 text-border" strokeWidth={2.4} />
          <span
            aria-current="page"
            className="overflow-hidden text-ellipsis rounded-full bg-primary/10 px-3 py-1.5 font-semibold text-primary"
          >
            {title}
          </span>
        </nav>

        <div className="mt-7 flex flex-wrap items-end justify-between gap-x-12 gap-y-5">
          <div className="flex min-w-0 flex-1 basis-[520px] flex-col gap-3.5">
            <h1 className="m-0 text-[clamp(40px,6vw,88px)] font-black leading-[0.94] tracking-[-0.05em] text-balance">
              {title}
            </h1>
            {lede && <p className={cn("m-0", INFO_LEDE)}>{lede}</p>}
          </div>
          {legal && (
            <div className="flex flex-wrap items-center gap-2.5">
              <span className="flex h-11 items-center gap-2 rounded-full bg-background px-4 text-sm font-semibold text-graphite">
                <Clock aria-hidden className="size-[15px] text-muted-foreground" strokeWidth={2} />
                Mise à jour : {INFO_UPDATED}
              </span>
              <PrintButton />
            </div>
          )}
        </div>
      </section>

      {/* Side nav + content */}
      <div className="grid items-start gap-5 min-[900px]:grid-cols-[260px_minmax(0,1fr)]">
        <aside
          className={cn(
            "top-3 flex min-w-0 gap-1 self-start overflow-x-auto rounded-full bg-card p-1.5 [scrollbar-width:none] min-[900px]:sticky min-[900px]:flex-col min-[900px]:gap-3.5 min-[900px]:rounded-[32px] min-[900px]:p-3.5 min-[900px]:overflow-visible",
          )}
        >
          {nav.map((group) => (
            <div key={group.key} className="flex shrink-0 flex-row gap-1 min-[900px]:flex-col">
              <span className="hidden px-3.5 pt-1.5 text-[11px] font-extrabold uppercase tracking-[0.14em] text-muted-foreground min-[900px]:block">
                {group.label}
              </span>
              {group.items.map((it) => (
                <Link
                  key={it.slug}
                  href={it.href}
                  aria-current={it.current ? "page" : undefined}
                  className={cn(
                    "flex min-h-[46px] items-center justify-between gap-2.5 whitespace-nowrap rounded-full px-4 text-[15px] transition-colors",
                    it.current
                      ? "bg-primary/10 font-extrabold text-primary"
                      : "font-semibold text-foreground hover:bg-muted",
                  )}
                >
                  {it.label}
                  <span
                    aria-hidden
                    className={cn(
                      "size-[7px] shrink-0 rounded-full bg-primary transition-opacity",
                      it.current ? "opacity-100" : "opacity-0",
                    )}
                  />
                </Link>
              ))}
            </div>
          ))}

          {/* Besoin d'aide ? — desktop only */}
          <div className="mt-2 hidden flex-col gap-3 rounded-[24px] bg-foreground p-[18px] text-background min-[900px]:flex">
            <span className="text-[15px] font-extrabold">Besoin d&apos;aide ?</span>
            <span className="text-[13px] leading-[1.5] text-background/70">
              Notre équipe vous répond du lundi au samedi.
            </span>
            {phone ? (
              <a
                href={tel || undefined}
                className="flex h-11 items-center justify-center gap-2 rounded-full bg-primary text-sm font-bold text-primary-foreground transition-[filter] hover:brightness-95"
              >
                <Phone aria-hidden className="size-[15px]" strokeWidth={2} />
                {phone.replace("+216", "").trim()}
              </a>
            ) : (
              <Link
                href="/aide"
                className="flex h-11 items-center justify-center gap-2 rounded-full bg-primary text-sm font-bold text-primary-foreground transition-[filter] hover:brightness-95"
              >
                <Phone aria-hidden className="size-[15px]" strokeWidth={2} />
                Contactez-nous
              </Link>
            )}
          </div>
        </aside>

        <div className="flex min-w-0 flex-col gap-5">{children}</div>
      </div>
    </div>
  );
}
