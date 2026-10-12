"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  type LucideIcon,
  BatteryCharging,
  Cable,
  CalendarClock,
  Camera,
  Car,
  ChevronRight,
  Flame,
  Gamepad2,
  Gift,
  Headphones,
  House,
  Keyboard,
  Laptop,
  LayoutGrid,
  Lightbulb,
  MapPin,
  Mic,
  Monitor,
  MonitorSmartphone,
  Mouse,
  Music,
  Package,
  Shield,
  Smartphone,
  Sparkles,
  Speaker,
  Tablet,
  Tv,
  Watch,
} from "lucide-react";

import { CategoryEditorial } from "@/storefront/components/storefront/listing/category-editorial";
import { ListingRegion } from "@/storefront/components/storefront/listing/listing-region";
import { ServiceBand } from "@/storefront/components/storefront/listing/service-band";
import { useProductListing } from "@/storefront/components/storefront/listing/use-listing";
import type { Product } from "@/storefront/lib/catalog";
import {
  categoryTrail,
  getNavContext,
  universeCrumbs,
  type NavCrumb,
} from "@/storefront/lib/categoryNav";
import { getCategoryBlurb } from "@/storefront/lib/categorySeo";
import { smoothBehavior } from "@/storefront/lib/motion";
import { getNavAlias } from "@/storefront/lib/navAliases";
import { cn } from "@/storefront/lib/utils";

/* ---- Sub-category icon mapping (first match wins; specific before broad) ---- */
const SUB_ICONS: [RegExp, LucideIcon][] = [
  [/tablette|ipad/i, Tablet],
  [/iphone|smartphone|t[eé]l[eé]phon/i, Smartphone],
  [/\bmac\b|\bpc\b|laptop|ordinateur/i, Laptop],
  [/[eé]cran|moniteur/i, Monitor],
  [/clavier/i, Keyboard],
  [/souris|tapis/i, Mouse],
  [/enceinte|haut-parleur|\bson\b/i, Speaker],
  [/casque|[eé]couteur|airpod|audio/i, Headphones],
  [/micro/i, Mic],
  [/montre|watch|objets? connect/i, Watch],
  [/air ?tags?/i, MapPin],
  [/apple/i, MonitorSmartphone],
  [/power ?bank|batterie/i, BatteryCharging],
  [/c[aâ]ble|alimentation|chargeur|adaptateur/i, Cable],
  [/protection|coque|[eé]tui|verre|film|magsafe/i, Shield],
  [/voiture/i, Car],
  [/console|jeux?\b|gaming|playstation|nintendo|xbox|\bps[45]\b|switch/i, Gamepad2],
  [/itunes|musique/i, Music],
  [/netflix|streaming/i, Tv],
  [/gift|carte|cadeau|abonnement/i, Gift],
  [/photo|cam[eé]ra/i, Camera],
  [/[eé]clairage|lumi[eè]re|lampe/i, Lightbulb],
  [/maison|domotique/i, House],
  [/pr[eé]commande/i, CalendarClock],
  [/tendance/i, Flame],
  [/univers tokyo|gadget|lifestyle/i, Sparkles],
  [/accessoire|divers|autre|pack/i, Package],
];

function subIcon(label: string | undefined): LucideIcon | undefined {
  if (label) for (const [re, Icon] of SUB_ICONS) if (re.test(label)) return Icon;
}
function tileIcon(c: NavCrumb): LucideIcon {
  return subIcon(c.label) ?? subIcon(getNavContext(c.slug).universe?.label) ?? Package;
}
/* An alias spelling wins over taxonomy ("Gift Cards", not "Gift-Cards"). */
function navLabel(c: NavCrumb): string {
  return getNavAlias(c.slug)?.label ?? c.label;
}

/* ---------------- Sub-category pill rail ---------------- */

type Pill = { slug: string; label: string; icon: LucideIcon; count?: number; active: boolean };

function SubCategoryPills({ pills }: { pills: Pill[] }) {
  const railRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [hidden, setHidden] = useState(0);

  /* Measure how many pills fall below the two-row collapsed cap, so the toggle
     reads "Tout afficher (+N)". Re-runs on resize and when the pills change. */
  useEffect(() => {
    const rail = railRef.current;
    if (!rail) return;
    const measure = () => {
      const kids = Array.from(rail.children) as HTMLElement[];
      if (kids.length === 0) return setHidden(0);
      const firstTop = kids[0].offsetTop;
      const rowH = kids[0].offsetHeight;
      const cap = firstTop + rowH * 2 + 10; // two rows + the row gap
      setHidden(kids.filter((k) => k.offsetTop >= cap).length);
    };
    measure();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    ro?.observe(rail);
    return () => ro?.disconnect();
  }, [pills]);

  const collapsible = hidden > 0;

  return (
    <div className="flex flex-col gap-3 border-t border-border/70 pt-5">
      <div className="flex items-center justify-between gap-3">
        <span className="text-[13px] font-extrabold uppercase tracking-[0.12em] text-muted-foreground">
          Sous-catégories <span className="text-foreground">· {pills.length}</span>
        </span>
        {collapsible && (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="h-10 rounded-full bg-secondary px-4 text-[13px] font-bold text-foreground transition-colors duration-200 hover:bg-foreground hover:text-background"
          >
            {expanded ? "Réduire" : `Tout afficher (+${hidden})`}
          </button>
        )}
      </div>
      <div
        ref={railRef}
        className="flex flex-wrap gap-2 overflow-hidden transition-[max-height] duration-500 ease-out"
        style={{ maxHeight: expanded || !collapsible ? 2000 : 116 }}
      >
        {pills.map((p) => {
          const Icon = p.icon;
          return (
            <Link
              key={p.slug}
              href={`/${p.slug}`}
              aria-current={p.active ? "page" : undefined}
              className={cn(
                "flex h-12 shrink-0 items-center gap-2.5 rounded-full py-0 pl-1.5 pr-4 transition-colors duration-200 sm:h-14",
                p.active
                  ? "bg-foreground text-background"
                  : "bg-secondary text-foreground hover:brightness-[0.97]",
              )}
            >
              <span className="grid size-9 shrink-0 place-items-center rounded-full bg-background text-foreground sm:size-11">
                <Icon aria-hidden className="size-4 sm:size-5" strokeWidth={2} />
              </span>
              <span className="flex flex-col items-start">
                <span className="whitespace-nowrap text-[14px] font-bold sm:text-[15px]">
                  {p.label}
                </span>
                {!!p.count && (
                  <span className="whitespace-nowrap text-[11px] opacity-70">
                    {p.count} produit{p.count > 1 ? "s" : ""}
                  </span>
                )}
              </span>
            </Link>
          );
        })}
      </div>
    </div>
  );
}

/* ---------------- Category view ---------------- */

export function CategoryView({
  slug,
  label,
  products,
  subNav: resolvedSubNav,
  trail: resolvedTrail,
  subNavCounts,
}: {
  slug: string;
  label: string;
  products: Product[];
  /** Server-filtered story tiles (slugs that resolve). */
  subNav?: NavCrumb[];
  /** Breadcrumb universe / section links, filtered the same way. */
  trail?: NavCrumb[];
  /** Optional per-sub-category product counts (slug → count), computed server-side. */
  subNavCounts?: Record<string, number>;
}) {
  const nav = useMemo(() => getNavContext(slug), [slug]);
  const subNav = resolvedSubNav ?? (nav.siblings.length > 0 ? nav.siblings : universeCrumbs);
  const trail = resolvedTrail ?? categoryTrail(slug);

  const listing = useProductListing(products);
  const aboutRef = useRef<HTMLDivElement>(null);

  const pills: Pill[] = [];
  if (nav.universe) {
    pills.push({
      slug: nav.universe.slug,
      label: `Tout ${navLabel(nav.universe)}`,
      icon: LayoutGrid,
      count: subNavCounts?.[nav.universe.slug],
      active: nav.universe.slug === slug,
    });
  }
  subNav.forEach((c) =>
    pills.push({
      slug: c.slug,
      label: navLabel(c),
      icon: tileIcon(c),
      count: subNavCounts?.[c.slug],
      active: c.slug === slug,
    }),
  );

  const scrollToAbout = () => {
    const el = aboutRef.current;
    if (!el) return;
    window.scrollTo({
      top: el.getBoundingClientRect().top + window.scrollY - 20,
      behavior: smoothBehavior(),
    });
  };

  return (
    <div className="page-container flex flex-col gap-5 pt-3">
      {/* 1. Category header */}
      <section className="flex flex-col gap-7 rounded-[36px] bg-background p-6 sm:p-9 lg:p-12">
        <nav aria-label="Fil d'Ariane" className="flex min-w-0 items-center gap-1.5 overflow-hidden">
          <Link
            href="/"
            aria-label="Accueil"
            className="grid size-[30px] shrink-0 place-items-center rounded-full bg-secondary text-foreground transition-colors hover:bg-primary/10 hover:text-primary"
          >
            <House aria-hidden className="size-3.5" strokeWidth={2} />
          </Link>
          {trail.map((c) => (
            <span key={c.slug} className="flex min-w-0 items-center gap-1.5">
              <ChevronRight aria-hidden className="size-3 shrink-0 text-muted-foreground/50" strokeWidth={2.4} />
              <Link
                href={`/${c.slug}`}
                className="truncate px-0.5 py-1 text-[13px] text-muted-foreground transition-colors hover:text-primary"
              >
                {navLabel(c)}
              </Link>
            </span>
          ))}
          <ChevronRight aria-hidden className="size-3 shrink-0 text-muted-foreground/50" strokeWidth={2.4} />
          <span
            aria-current="page"
            className="shrink-0 rounded-full bg-primary/10 px-3 py-1.5 text-[13px] font-semibold text-primary"
          >
            {label}
          </span>
        </nav>

        <div className="flex flex-col gap-3.5">
          <h1 className="text-[clamp(40px,6.5vw,88px)] font-black leading-[0.92] tracking-[-0.05em] text-foreground">
            {label}
          </h1>
          <p
            id="cat-status"
            role="status"
            aria-live="polite"
            className="text-[13px] font-semibold text-muted-foreground"
          >
            <span className="text-foreground">{listing.count}</span> produit
            {listing.count === 1 ? "" : "s"}
            {listing.count !== products.length && ` sur ${products.length}`}
          </p>
          <p className="max-w-[72ch] text-[16px] leading-relaxed text-graphite text-pretty">
            {getCategoryBlurb(label)}{" "}
            <button
              type="button"
              onClick={scrollToAbout}
              className="font-bold text-foreground underline underline-offset-[3px]"
            >
              En savoir plus
            </button>
          </p>
        </div>

        {pills.length > 1 && <SubCategoryPills pills={pills} />}
      </section>

      {/* 2. Listing */}
      <ListingRegion listing={listing} />

      {/* 3. Service band */}
      <ServiceBand />

      {/* 4. About + FAQ */}
      <div ref={aboutRef} className="flex scroll-mt-5 flex-col gap-5">
        <CategoryEditorial label={label} />
      </div>
    </div>
  );
}
