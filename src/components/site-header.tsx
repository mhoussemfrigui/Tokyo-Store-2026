"use client";

import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createElement, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Search,
  ShoppingBag,
  Heart,
  User,
  X,
  ArrowRight,
} from "lucide-react";

import type { RenderableBanner } from "@/lib/api/cms";
import { promoIcon } from "@/lib/links/promo-icons";
import { useWishlist } from "@/components/wishlist/wishlist-provider";
import { chunkColumns } from "@/lib/cms/nav-composer-model";
import type { NavBlockSize, NavImageAspect, ResolvedNavBlock, ResolvedNavColumn, ResolvedNavRoot } from "@/lib/cms/nav-composer-model";

// Static Tailwind aspect classes per featured-image FORMAT (the admin picks one
// so the source fills without cropping). Listed literally so Tailwind generates
// them. Keep in sync with NAV_IMAGE_ASPECTS in nav-composer-model.ts.
const NAV_ASPECT_CLASS: Record<NavImageAspect, string> = {
  landscape: "aspect-[4/3]",
  square: "aspect-square",
  portrait: "aspect-[3/4]",
  long: "aspect-[2/3]",
  longer: "aspect-[9/16]",
};

// Per-size classes for the visual blocks (NAV_BLOCK_SIZES). `md` = the classic
// look (so an unset / legacy block renders unchanged). Listed literally so
// Tailwind generates them. Keep in sync with NAV_BLOCK_SIZES in the model: the
// admin picks Petit/Moyen/Grand and each block maps it to its natural dimension
// — product grid DENSITY, brand-logo HEIGHT, image panel WIDTH.
const NAV_PRODUCTS_GRID: Record<NavBlockSize, string> = {
  sm: "grid-cols-3 gap-x-4 gap-y-4",
  md: "grid-cols-2 gap-x-6 gap-y-5",
  lg: "grid-cols-1 gap-y-6",
};
const NAV_BRAND_LOGO: Record<NavBlockSize, string> = {
  sm: "h-5 max-w-[72px]",
  md: "h-7 max-w-[96px]",
  lg: "h-10 max-w-[128px]",
};
const NAV_IMAGE_WIDTH: Record<NavBlockSize, string> = {
  sm: "w-[280px]",
  md: "w-[340px]",
  lg: "w-[420px]",
};

/* ─────────────────────────────────────────────────────────────────────────
 * Types — the (shop) layout prop contract is PRESERVED EXACTLY. Only the
 * markup is re-authored to the Tokyo luxury design.
 * ──────────────────────────────────────────────────────────────────────── */

/** target/rel for an admin "open in a new tab" link (mirrors the footer). */
function newTabProps(newTab?: boolean) {
  return newTab ? { target: "_blank" as const, rel: "noopener noreferrer" } : {};
}

/** Admin-picked nav icon; an unknown / stale / prototype key renders nothing
 *  (promoIcon does an OWN-key lookup, so "constructor" can't become a component). */
function NavRootIcon({ icon, className }: { icon?: string | null; className: string }) {
  // Own-key lookup (crash-safe); createElement avoids the looked-up component being
  // flagged as created-in-render by the React Compiler lint.
  const comp = promoIcon(icon);
  return comp ? createElement(comp, { className, strokeWidth: 1.5, "aria-hidden": true }) : null;
}

/** The soft olive arrow on a dropdown link row (shared style). */
function RowArrow() {
  return (
    <ArrowRight
      className="relative z-10 h-3.5 w-3.5 -translate-x-2 text-olive opacity-0 transition-all duration-300 group-hover:translate-x-0 group-hover:opacity-60"
      strokeWidth={1.5}
    />
  );
}

/**
 * Renders ONE dropdown content block (links / categories / brands / products)
 * inside a mega-menu COLUMN, keeping the same visual language
 * (olive-arrow link rows, soft cards). A list block with `maxPerColumn` set wraps
 * its items into column-major sub-columns (overflow into the next sub-column).
 * Image blocks are rendered flush by the panel itself, not here.
 */
function DropdownBlock({ block, onNavigate }: { block: ResolvedNavBlock; onNavigate: () => void }) {
  if (block.type === "image") return null;
  const Title = block.title ? (
    <p className="mb-3 font-body text-[0.6rem] uppercase tracking-[0.2em] text-muted-foreground/70">
      {block.title}
    </p>
  ) : null;

  // Auto taxonomy sections — each sub-category section as a titled group of rows.
  if (block.type === "taxonomy") {
    if (block.sections.length === 0) return null;
    return (
      <div className="space-y-6">
        {Title}
        {block.sections.map((sec, si) => (
          <div key={si}>
            {sec.title ? (
              sec.href ? (
                <Link
                  href={sec.href}
                  onClick={onNavigate}
                  className="mb-3 block font-body text-[0.6rem] uppercase tracking-[0.2em] text-muted-foreground/70 transition-colors hover:text-foreground"
                >
                  {sec.title}
                </Link>
              ) : (
                <p className="mb-3 font-body text-[0.6rem] uppercase tracking-[0.2em] text-muted-foreground/70">
                  {sec.title}
                </p>
              )
            ) : null}
            <ul className="space-y-0.5">
              {sec.items.map((sub, i) => (
                <li key={i}>
                  <Link
                    href={sub.href}
                    onClick={onNavigate}
                    className="ink-track group -mx-3 flex items-center gap-4 rounded-xl px-3 py-2.5"
                  >
                    <span className="relative z-10 font-body text-base tracking-wide text-foreground/70 transition-colors duration-300 group-hover:text-foreground">
                      {sub.label}
                    </span>
                    <RowArrow />
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    );
  }

  // Product preview — small image tiles with the name under each.
  if (block.type === "products") {
    if (block.items.length === 0) return null;
    return (
      <div>
        {Title}
        <div className={`grid ${NAV_PRODUCTS_GRID[block.size] ?? NAV_PRODUCTS_GRID.md}`}>
          {block.items.map((p, i) => (
            <Link key={i} href={p.href} onClick={onNavigate} className="group block">
              <div className="relative aspect-square overflow-hidden rounded-xl bg-muted/30">
                {p.imageUrl && (
                  <Image
                    src={p.imageUrl}
                    alt={p.name}
                    fill
                    sizes="180px"
                    className="object-cover transition-transform duration-500 group-hover:scale-105"
                  />
                )}
              </div>
              <p className="mt-2 font-body text-[0.8rem] tracking-wide text-foreground/70 transition-colors duration-300 group-hover:text-foreground">
                {p.name}
              </p>
            </Link>
          ))}
        </div>
      </div>
    );
  }

  // Brands with logos (or logos + titles) — a grid of logo tiles.
  if (block.type === "brands" && block.display !== "titles") {
    return (
      <div>
        {Title}
        <div className="grid grid-cols-2 gap-3">
          {block.items.map((b, i) => (
            <Link
              key={i}
              href={b.href}
              onClick={onNavigate}
              className="ink-track group flex items-center gap-3 rounded-xl px-3 py-2.5"
            >
              {b.imageUrl ? (
                <Image
                  src={b.imageUrl}
                  alt={b.label}
                  width={72}
                  height={32}
                  className={`relative z-10 w-auto ${NAV_BRAND_LOGO[block.size] ?? NAV_BRAND_LOGO.md} object-contain opacity-75 transition-opacity duration-300 group-hover:opacity-100`}
                />
              ) : null}
              {(block.display === "both" || !b.imageUrl) && (
                <span className="relative z-10 font-body text-sm tracking-wide text-foreground/70 transition-colors duration-300 group-hover:text-foreground">
                  {b.label}
                </span>
              )}
            </Link>
          ))}
        </div>
      </div>
    );
  }

  // Default — the classic olive-arrow link rows (links / categories / brand
  // titles), wrapped into column-major sub-columns when the block sets
  // `maxPerColumn` (overflow into the next sub-column).
  if (block.items.length === 0) return null;
  const groups = chunkColumns(block.items, block.maxPerColumn);
  return (
    <div>
      {Title}
      <div className={groups.length > 1 ? "flex gap-x-10" : ""}>
        {groups.map((group, gi) => (
          <ul key={gi} className="flex-1 space-y-0.5">
            {group.map((sub, i) => (
              <li key={i}>
                <Link
                  href={sub.href}
                  {...newTabProps(sub.newTab)}
                  onClick={onNavigate}
                  className="ink-track group -mx-3 flex items-center gap-4 rounded-xl px-3 py-2.5"
                >
                  <span className="relative z-10 font-body text-base tracking-wide text-foreground/70 transition-colors duration-300 group-hover:text-foreground">
                    {sub.label}
                  </span>
                  <RowArrow />
                </Link>
              </li>
            ))}
          </ul>
        ))}
      </div>
    </div>
  );
}

/** Renders ONE dropdown column — its stacked content blocks, OR, when the column
 *  holds a single image block, the flush featured image panel (the classic tall
 *  visual pinned to the column). `eyebrow` (the root label) prints once, above
 *  the first content column. */
function DropdownColumn({
  column,
  index,
  total,
  eyebrow,
  fallbackHref,
  onNavigate,
}: {
  column: ResolvedNavColumn;
  index: number;
  total: number;
  eyebrow?: string;
  fallbackHref: string;
  onNavigate: () => void;
}) {
  const soleImage =
    column.blocks.length === 1 && column.blocks[0].type === "image" ? column.blocks[0] : null;
  if (soleImage) {
    // Position-aware: at either EDGE the image bleeds flush to the panel border
    // (the premium full-height panel look); anywhere in the MIDDLE it renders as
    // a contained, rounded card with breathing room so it sits between content
    // columns instead of butting against them. Either way it stays a fixed 3:4
    // box (340×453), vertically centered, so its aspect never stretches.
    const atEdge = index === 0 || index === total - 1;
    return (
      <Link
        href={soleImage.href && soleImage.href !== "#" ? soleImage.href : fallbackHref}
        onClick={onNavigate}
        className={`group relative hidden ${NAV_ASPECT_CLASS[soleImage.aspect] ?? "aspect-[3/4]"} ${NAV_IMAGE_WIDTH[soleImage.size] ?? NAV_IMAGE_WIDTH.md} shrink-0 self-center overflow-hidden lg:block ${
          atEdge ? "" : "mx-4 rounded-2xl lg:mx-6"
        }`}
      >
        <Image
          src={soleImage.imageUrl}
          alt={soleImage.imageAlt ?? soleImage.title ?? ""}
          fill
          sizes="420px"
          className="object-cover transition-transform duration-700 group-hover:scale-105"
        />
        <div className="absolute inset-0 bg-gradient-to-t from-foreground/70 via-foreground/20 to-transparent" />
        {(soleImage.eyebrow || soleImage.title) && (
          <div className="absolute inset-x-0 bottom-0 p-8">
            {soleImage.eyebrow && (
              <p className="mb-2 font-body text-[0.55rem] uppercase tracking-[0.3em] text-background/50">
                {soleImage.eyebrow}
              </p>
            )}
            {soleImage.title && <h3 className="font-serif text-2xl text-background">{soleImage.title}</h3>}
          </div>
        )}
      </Link>
    );
  }
  return (
    <div className="flex flex-1 flex-col justify-center px-10 py-10 lg:px-16">
      {eyebrow && (
        <p className="mb-8 font-body text-[0.6rem] uppercase tracking-[0.3em] text-muted-foreground">
          {eyebrow}
        </p>
      )}
      <div className="space-y-8">
        {column.blocks.map((block, bi) => (
          <DropdownBlock key={bi} block={block} onNavigate={onNavigate} />
        ))}
      </div>
    </div>
  );
}


/* ─────────────────────────────────────────────────────────────────────────
 * SiteHeader
 * ──────────────────────────────────────────────────────────────────────── */

export function SiteHeader({
  navRoots = [],
  searchSuggestions = [],
  headerStripBanners = [],
  cartCount = 0,
  logoUrl = null,
  siteName = "Tokyo Store",
  tagline = "Votre expert en produits technologiques de pointe",
  searchMinQueryLength = 2,
}: {
  /** The resolved, data-driven mega-menu roots (CMS → Nav Menu). Built server-side
   *  by getComposedNavRoots from the materialized `main` menu + live catalog/média. */
  navRoots?: ResolvedNavRoot[];
  /** « Recherches populaires » chips in the search morph — the site's top
   *  categories, sourced independently of the nav composition so they show even
   *  when no nav root has a categories block. */
  searchSuggestions?: { label: string; href: string }[];
  headerStripBanners?: RenderableBanner[];
  cartCount?: number;
  /** Médiathèque logo resolved to a /cdn URL server-side. Null ⇒ text wordmark. */
  logoUrl?: string | null;
  siteName?: string;
  tagline?: string;
  searchMinQueryLength?: number;
}) {
  const router = useRouter();

  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const [activeDropdown, setActiveDropdown] = useState<string | null>(null);
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [isScrolled, setIsScrolled] = useState(false);
  const closeTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Keep message + style on ONE object per strip so a blank-title banner can't
  // make the message index and the styling index diverge (they used to be two
  // arrays of different lengths indexed by the same counter).
  const strips = headerStripBanners.filter((b) => Boolean(b.title && b.title.trim()));

  const [stripIndex, setStripIndex] = useState(0);
  useEffect(() => {
    if (strips.length <= 1) return;
    const id = setInterval(() => setStripIndex((i) => (i + 1) % strips.length), 4000);
    return () => clearInterval(id);
  }, [strips.length]);
  const currentStripBanner = strips[stripIndex] ?? strips[0] ?? null;
  const currentStrip = currentStripBanner?.title ?? null;

  useEffect(() => {
    const onScroll = () => setIsScrolled(window.scrollY > 20);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const handleMouseEnter = useCallback((name: string) => {
    if (closeTimeout.current) clearTimeout(closeTimeout.current);
    setActiveDropdown(name);
  }, []);
  const handleMouseLeave = useCallback(() => {
    closeTimeout.current = setTimeout(() => setActiveDropdown(null), 200);
  }, []);

  useEffect(() => {
    if (!activeDropdown) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setActiveDropdown(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [activeDropdown]);

  useEffect(() => {
    const lock = isMobileMenuOpen;
    document.body.style.overflow = lock ? "hidden" : "";
    return () => {
      document.body.style.overflow = "";
    };
  }, [isMobileMenuOpen]);

  const wl = useWishlist();
  const wishlistCount = wl?.count ?? 0;

  const activeNav = navRoots.find((r) => r.key === activeDropdown) ?? null;

  // "Recherches populaires" in the search morph — the site's top categories
  // (passed independently of the nav composition), falling back to the first
  // categories block only when the prop is empty. Desktop only.
  const popularSearches: { label: string; href: string }[] =
    searchSuggestions.length > 0
      ? searchSuggestions
      : (navRoots.flatMap((r) => r.columns.flatMap((c) => c.blocks)).find((b) => b.type === "categories")?.items ?? []).slice(0, 3);

  const submitSearch = () => {
    const q = searchQuery.trim();
    // Honour the admin « longueur minimale » knob client-side: a too-short query
    // would only land on the /recherche "Tapez au moins N caractères" empty state,
    // so don't burn a navigation on it (mirrors the route/page/service guards).
    if (!q || q.length < searchMinQueryLength) return;
    router.push(`/recherche?q=${encodeURIComponent(q)}`);
    setIsSearchOpen(false);
    setSearchQuery("");
  };

  return (
    <>
      <header className="sticky top-0 z-50 w-full">
        {/* ═══════ STATUS BAR (rotating header-strip message) ═══════ */}
        {currentStrip && currentStripBanner ? (
          <div
            className={STRIP_TONE_CLASS[currentStripBanner.stripTone].className}
            style={{
              paddingTop: "max(0.5rem, env(safe-area-inset-top, 0px))",
              ...STRIP_TONE_CLASS[currentStripBanner.stripTone].style,
            }}
          >
            <div className="container mx-auto flex h-5 items-center justify-center gap-2 overflow-hidden px-4 pb-2 text-center">
              <StatusMessage
                key={stripIndex}
                message={currentStrip}
                // "#" is the read-seam's blank/unsafe fallback — not a real link, so the
                // message stays static text rather than a dead anchor to the top of the page.
                href={
                  currentStripBanner.ctaHref && currentStripBanner.ctaHref !== "#"
                    ? currentStripBanner.ctaHref
                    : null
                }
                icon={currentStripBanner.stripIcon}
              />
              {currentStripBanner.showCountdown && currentStripBanner.endAt && (
                <StripCountdown endAt={currentStripBanner.endAt} />
              )}
            </div>
          </div>
        ) : null}

        {/* ═══════ MAIN NAV ROW ═══════ */}
        <nav
          className={`relative ink-track ink-track-nav border-b border-border/40 transition-all duration-500 ${
            isScrolled
              ? "bg-background/95 shadow-[0_1px_20px_-6px_hsl(var(--primary)/0.06)] backdrop-blur-md"
              : "bg-background"
          }`}
          onMouseLeave={handleMouseLeave}
        >
          <div className="relative z-[60] flex h-[56px] items-center justify-between px-4 md:h-[64px] md:px-6 lg:h-[72px] lg:px-10">
            {/* LEFT: hamburger (mobile) / nav links (desktop) */}
            <div className="flex items-center">
              <button
                className="ink-track relative z-[70] -ml-1 flex min-h-[44px] min-w-[44px] items-center justify-center rounded-xl p-2.5 text-foreground/70 transition-colors duration-300 hover:text-primary lg:hidden"
                onClick={() => setIsMobileMenuOpen((p) => !p)}
                aria-label="Menu"
                aria-expanded={isMobileMenuOpen}
              >
                <span className="relative z-10 flex h-4 w-5 flex-col justify-between">
                  <span
                    className={`block h-[1.5px] w-5 origin-center bg-current transition-all duration-300 ${
                      isMobileMenuOpen ? "translate-y-[7px] rotate-45" : ""
                    }`}
                  />
                  <span
                    className={`block h-[1.5px] w-3.5 bg-current transition-all duration-300 ${
                      isMobileMenuOpen ? "w-0 opacity-0" : "opacity-100"
                    }`}
                  />
                  <span
                    className={`block h-[1.5px] w-5 origin-center bg-current transition-all duration-300 ${
                      isMobileMenuOpen ? "-translate-y-[7px] -rotate-45" : ""
                    }`}
                  />
                </span>
              </button>

              <div className="hidden items-center gap-8 lg:flex">
                {navRoots.map((item) => {
                  const hasDrop = item.columns.length > 0;
                  const isLink = Boolean(item.href && item.href !== "#");
                  const triggerCls = `flex items-center gap-1.5 py-6 font-body text-[0.8rem] font-medium uppercase tracking-[0.18em] transition-all duration-500 ${
                    activeDropdown === item.key ? "text-foreground" : "text-foreground/60 hover:text-foreground"
                  }`;
                  // Focusing the root reveals its panel (keyboard/sighted users)
                  // and aria-haspopup/expanded announce it; Escape closes it. Full
                  // arrow-key menu navigation isn't implemented — aria-haspopup is
                  // "true" (a popup) not "menu" (which would promise that); the
                  // mobile menu gives keyboard users every link directly.
                  const triggerA11y = hasDrop
                    ? { "aria-haspopup": true as const, "aria-expanded": activeDropdown === item.key, onFocus: () => handleMouseEnter(item.key) }
                    : {};
                  return (
                    <div key={item.key} className="relative" onMouseEnter={() => handleMouseEnter(item.key)}>
                      {isLink ? (
                        <Link href={item.href} {...newTabProps(item.newTab)} className={triggerCls} {...triggerA11y}>
                          <NavRootIcon icon={item.icon} className="h-3.5 w-3.5 shrink-0" />
                          {item.label}
                        </Link>
                      ) : (
                        // A root with no own link (a pure dropdown trigger) is a
                        // button, not a dead `#` link — also opens on click/tap.
                        <button
                          type="button"
                          className={triggerCls}
                          onClick={() => setActiveDropdown((cur) => (cur === item.key ? null : item.key))}
                          {...triggerA11y}
                        >
                          <NavRootIcon icon={item.icon} className="h-3.5 w-3.5 shrink-0" />
                          {item.label}
                        </button>
                      )}
                      <span
                        className={`pointer-events-none absolute bottom-2 left-1/2 h-[5px] w-[5px] -translate-x-[calc(50%+4px)] rounded-full bg-olive transition-all duration-300 ${
                          activeDropdown === item.key ? "scale-100 opacity-100" : "scale-0 opacity-0"
                        }`}
                      />
                    </div>
                  );
                })}
              </div>
            </div>

            {/* CENTER: médiathèque logo (text wordmark fallback) */}
            <div className="absolute left-1/2 -translate-x-1/2">
              <Link href="/" aria-label={`${siteName} — Accueil`} className="group block">
                {logoUrl ? (
                  <Image
                    src={logoUrl}
                    alt={siteName}
                    width={264}
                    height={88}
                    priority
                    className="h-12 w-auto select-none object-contain transition-opacity duration-700 group-hover:opacity-70 md:h-16 lg:h-[72px]"
                  />
                ) : (
                  // Default brand logo — shown even WITHOUT the demo (no
                  // `site.logo_media_id` set): the bundled Tokyo "RK" monogram
                  // (public/tokyo-logo.png, the same artwork an admin upload
                  // resolves to). An uploaded média logo still overrides it.
                  <Image
                    src="/tokyo-logo.png"
                    alt={tagline ? `${siteName} — ${tagline}` : siteName}
                    width={1357}
                    height={1920}
                    priority
                    className="h-12 w-auto select-none object-contain transition-opacity duration-700 group-hover:opacity-70 md:h-16 lg:h-[72px]"
                  />
                )}
              </Link>
            </div>

            {/* RIGHT: espace pro · account · search · wishlist · cart */}
            <div
              className="flex items-center gap-0.5"
              style={{ WebkitTapHighlightColor: "transparent" }}
            >
              <Link
                href="/account"
                aria-label="Compte"
                className="ink-track rounded-xl p-2.5 text-foreground/50 transition-all duration-300 hover:text-foreground"
              >
                <User className="relative z-10 h-[17px] w-[17px]" strokeWidth={1.3} />
              </Link>

              <button
                type="button"
                onClick={() => setIsSearchOpen(true)}
                aria-label="Rechercher"
                className="ink-track flex min-h-[44px] min-w-[44px] items-center justify-center rounded-xl p-2.5 text-foreground/50 transition-all duration-300 hover:text-foreground"
              >
                <Search className="relative z-10 h-[17px] w-[17px]" strokeWidth={1.3} />
              </button>

              {/* Wrapper is overflow-visible so the corner count pill can sit
                  OUTSIDE the .ink-track link (which is overflow-hidden + rounded
                  and would otherwise clip the badge). */}
              <span className="relative hidden lg:inline-flex">
                <Link
                  href="/favoris"
                  aria-label="Liste de souhaits"
                  className="ink-track flex rounded-xl p-2.5 text-foreground/50 transition-all duration-300 hover:text-foreground"
                >
                  <Heart className="relative z-10 h-[17px] w-[17px]" strokeWidth={1.3} />
                </Link>
                {mounted && wishlistCount > 0 && (
                  <span className="pointer-events-none absolute -right-1 -top-1 z-20 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-olive px-1 font-body text-[0.55rem] font-medium leading-none text-olive-foreground">
                    {wishlistCount > 9 ? "9+" : wishlistCount}
                  </span>
                )}
              </span>

              {/* Cart + wishlist are HIDDEN on mobile — they live in the
                  MobileBottomBar pill instead (kept here for desktop). */}
              <span className="relative hidden lg:inline-flex">
                <Link
                  href="/panier"
                  aria-label="Panier"
                  className="ink-track flex rounded-xl p-2.5 text-foreground/50 transition-all duration-300 hover:text-foreground"
                >
                  <ShoppingBag className="relative z-10 h-[17px] w-[17px]" strokeWidth={1.3} />
                </Link>
                {cartCount > 0 && (
                  <span className="pointer-events-none absolute -right-1 -top-1 z-20 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-olive px-1 font-body text-[0.55rem] font-medium leading-none text-olive-foreground">
                    {cartCount > 9 ? "9+" : cartCount}
                  </span>
                )}
              </span>
            </div>
          </div>

          {/* ═══════ SEARCH MORPH — the nav row transforms into a search bar ═══════ */}
          {isSearchOpen && (
            <div className="search-morph absolute inset-x-0 top-0 z-[80] flex h-[56px] items-center bg-background px-4 md:h-[64px] md:px-6 lg:h-[72px] lg:px-10">
              <Search className="h-[18px] w-[18px] shrink-0 text-primary/60" strokeWidth={1.3} />
              <input
                type="text"
                autoFocus
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") submitSearch();
                  else if (e.key === "Escape") setIsSearchOpen(false);
                }}
                placeholder="Que recherchez-vous ?"
                aria-label="Rechercher"
                className="ml-3 flex-1 bg-transparent font-serif text-base tracking-wide text-foreground outline-none placeholder:text-muted-foreground/40 md:ml-4 lg:text-xl"
              />
              <div className="flex items-center gap-3">
                {/* Popular searches — the top categories (CMS-driven), desktop only. */}
                <div className="hidden items-center gap-2 lg:flex">
                  {popularSearches.map((c) => (
                    <button
                      key={c.href}
                      type="button"
                      onMouseDown={(e) => {
                        e.preventDefault();
                        router.push(c.href);
                        setIsSearchOpen(false);
                        setSearchQuery("");
                      }}
                      className="rounded-full border border-border/40 px-4 py-1.5 font-body text-[0.7rem] tracking-wide text-foreground/40 transition-all duration-300 hover:border-olive/40 hover:text-foreground"
                    >
                      {c.label}
                    </button>
                  ))}
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setIsSearchOpen(false);
                    setSearchQuery("");
                  }}
                  aria-label="Fermer la recherche"
                  className="ink-track rounded-xl p-2 text-foreground/40 transition-colors duration-300 hover:text-foreground"
                >
                  <X className="h-[17px] w-[17px]" strokeWidth={1.3} />
                </button>
              </div>
            </div>
          )}

          {/* ═══════ MEGA-MENU DROPDOWN ═══════ */}
          {activeNav && activeNav.columns.length > 0 && (() => {
            // The root label (eyebrow) prints once, above the first CONTENT column
            // (image-only columns are the flush featured panels).
            const firstContentIdx = activeNav.columns.findIndex(
              (c) => !(c.blocks.length === 1 && c.blocks[0].type === "image"),
            );
            return (
            <>
              <div
                className="fixed inset-0 z-40 bg-foreground/5 backdrop-blur-[2px]"
                onMouseEnter={() => setActiveDropdown(null)}
                onClick={() => setActiveDropdown(null)}
              />
              <div
                className="tk-fade-in-up absolute left-4 right-4 top-full z-50 overflow-hidden rounded-b-2xl border border-border/20 bg-background shadow-[0_20px_60px_-15px_hsl(var(--foreground)/0.12)] lg:left-8 lg:right-8"
                onMouseEnter={() => {
                  if (closeTimeout.current) clearTimeout(closeTimeout.current);
                }}
              >
                {/* Scrolls when a root stacks many/tall blocks, instead of clipping. */}
                <div className="flex min-h-[260px] max-h-[calc(100dvh-120px)] overflow-y-auto overscroll-contain">
                  {activeNav.columns.map((col, ci) => (
                    <DropdownColumn
                      key={ci}
                      column={col}
                      index={ci}
                      total={activeNav.columns.length}
                      eyebrow={ci === firstContentIdx ? activeNav.label : undefined}
                      fallbackHref={activeNav.href}
                      onNavigate={() => setActiveDropdown(null)}
                    />
                  ))}
                </div>
              </div>
            </>
            );
          })()}
        </nav>

        {/* ═══════ MOBILE MENU ═══════ */}
        {isMobileMenuOpen && (
          <>
            <div
              className="fixed inset-0 z-[55] bg-foreground/10 lg:hidden"
              onClick={() => setIsMobileMenuOpen(false)}
            />
            <div
              className="tk-fade-in-up absolute left-0 right-0 top-full z-[55] overflow-y-auto overscroll-contain border-t border-border/10 bg-background shadow-[0_20px_60px_-15px_hsl(var(--foreground)/0.12)] lg:hidden"
              style={{ maxHeight: "calc(100dvh - 88px)" }}
            >
              <div className="space-y-5 px-5 py-6">
                {navRoots.map((item) => {
                  // All of a root's blocks, flattened across its columns — mobile
                  // collapses the column layout into one stacked section.
                  const blocks = item.columns.flatMap((c) => c.blocks);
                  // Mobile shows a root's sub-links as pills only when the admin
                  // enabled it for mobile (per-root « visible sur mobile »);
                  // links/categories/brands/products contribute pills.
                  const pills = item.mobileVisible
                    ? blocks.flatMap((b) =>
                        b.type === "image"
                          ? []
                          : b.type === "products"
                            ? b.items.map((p) => ({ label: p.name, href: p.href, newTab: false }))
                            : b.type === "taxonomy"
                              ? b.sections.flatMap((sec) =>
                                  sec.items.map((s) => ({ label: s.label, href: s.href, newTab: false })),
                                )
                              : b.items.map((s) => ({
                                  label: s.label,
                                  href: s.href,
                                  newTab: s.newTab ?? false,
                                })),
                      )
                    : [];
                  // Image blocks flagged « afficher sur mobile » render as a small
                  // banner (mobile variant preferred), so the image feature works
                  // on phones too — per-image mobile control.
                  const mobileImages = item.mobileVisible
                    ? blocks.filter(
                        (b): b is Extract<ResolvedNavBlock, { type: "image" }> =>
                          b.type === "image" && b.showOnMobile,
                      )
                    : [];
                  return (
                    <div
                      key={item.key}
                      className="border-b border-border/15 pb-5 last:border-0"
                    >
                      {item.href && item.href !== "#" ? (
                        <Link
                          href={item.href}
                          {...newTabProps(item.newTab)}
                          className="mb-2.5 flex items-center gap-2 font-serif text-xl text-foreground"
                          onClick={() => setIsMobileMenuOpen(false)}
                        >
                          <NavRootIcon icon={item.icon} className="h-4 w-4 shrink-0" />
                          {item.label}
                        </Link>
                      ) : (
                        // A target-less root (pure dropdown trigger) is a heading on
                        // mobile, not a dead "#" anchor — its pills below do the nav.
                        <p className="mb-2.5 flex items-center gap-2 font-serif text-xl text-foreground">
                          <NavRootIcon icon={item.icon} className="h-4 w-4 shrink-0" />
                          {item.label}
                        </p>
                      )}
                      {pills.length > 0 && (
                        <div className="flex flex-wrap gap-2">
                          {pills.map((sub, i) => (
                            <Link
                              key={`${sub.href}-${i}`}
                              href={sub.href}
                              {...newTabProps(sub.newTab)}
                              className="rounded-full border border-border/40 px-3 py-1.5 font-body text-[0.65rem] uppercase tracking-[0.08em] text-foreground/75 transition-colors hover:text-foreground"
                              onClick={() => setIsMobileMenuOpen(false)}
                            >
                              {sub.label}
                            </Link>
                          ))}
                        </div>
                      )}
                      {mobileImages.map((img, i) => (
                        <Link
                          key={`img-${i}`}
                          href={img.href && img.href !== "#" ? img.href : item.href}
                          onClick={() => setIsMobileMenuOpen(false)}
                          className="group relative mt-3 block h-28 overflow-hidden rounded-2xl"
                        >
                          <Image
                            src={img.imageMobileUrl || img.imageUrl}
                            alt={img.imageAlt ?? img.title ?? ""}
                            fill
                            sizes="100vw"
                            className="object-cover"
                          />
                          <div className="absolute inset-0 bg-gradient-to-t from-foreground/60 to-transparent" />
                          {img.title && (
                            <span className="absolute inset-x-0 bottom-0 p-3 font-serif text-lg text-background">
                              {img.title}
                            </span>
                          )}
                        </Link>
                      ))}
                    </div>
                  );
                })}

              </div>
            </div>
          </>
        )}
      </header>

    </>
  );
}

/* ─────────────────────────────────────────────────────────────────────────
 * Sub-components
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * header_strip background tone (migration 0177). Olive is the default; onyx/gold
 * use the brand tokens; burgundy has no token, so it's an inline colour. Each
 * entry pairs a Tailwind className with an optional inline style (burgundy).
 */
const STRIP_TONE_CLASS: Record<
  "olive" | "dark" | "gold" | "burgundy",
  { className: string; style?: React.CSSProperties }
> = {
  olive: { className: "bg-olive text-olive-foreground" },
  dark: { className: "bg-foreground text-background" },
  gold: { className: "bg-gold text-gold-foreground" },
  burgundy: { className: "text-[#f6f3ec]", style: { backgroundColor: "#5b2130" } },
};

/** A single rotating status-bar message (CSS fade — no framer-motion). An optional
 *  leading emoji/glyph (banners.strip_icon) precedes the text. */
function StatusMessage({
  message,
  href,
  icon,
}: {
  message: string;
  href: string | null;
  icon?: string | null;
}) {
  const inner = (
    <span className="tk-fade-in-up block font-body text-[0.6rem] uppercase tracking-[0.25em]">
      {icon ? (
        <span aria-hidden className="mr-1.5 not-italic normal-case tracking-normal">
          {icon}
        </span>
      ) : null}
      {message}
    </span>
  );
  return href ? (
    <Link href={href} className="transition hover:opacity-80">
      {inner}
    </Link>
  ) : (
    inner
  );
}

/**
 * Live countdown to the banner's schedule end (header_strip, migration 0177).
 * Mounts empty and fills on the client so SSR/CSR never mismatch; renders nothing
 * once the deadline passes (the banner is about to drop out of `listLive` anyway).
 * The ticking digits are polite-announced off (aria-hidden) — a screen reader
 * doesn't need a per-second read-out; the message itself carries the urgency.
 */
function StripCountdown({ endAt }: { endAt: string }) {
  const target = useMemo(() => {
    const t = Date.parse(endAt);
    return Number.isNaN(t) ? null : t;
  }, [endAt]);
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    if (target === null) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [target]);

  if (target === null || now === null) return null;
  const remaining = target - now;
  if (remaining <= 0) return null;

  const totalSec = Math.floor(remaining / 1000);
  const days = Math.floor(totalSec / 86400);
  const hours = Math.floor((totalSec % 86400) / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const seconds = totalSec % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  const text =
    days > 0
      ? `J-${days} ${pad(hours)}:${pad(minutes)}:${pad(seconds)}`
      : `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;

  return (
    <span
      aria-hidden
      className="shrink-0 font-body text-[0.6rem] font-semibold tabular-nums tracking-[0.12em]"
    >
      {text}
    </span>
  );
}

