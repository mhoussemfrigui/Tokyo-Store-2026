"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import {
  ArrowLeft,
  ArrowRight,
  ChevronDown,
  Clapperboard,
  Clock,
  Flame,
  Gamepad2,
  Headphones,
  Heart,
  Home,
  Laptop,
  LayoutGrid,
  Menu,
  Phone,
  Search,
  ShoppingBag,
  Smartphone,
  TrendingUp,
  Tv,
  User,
  X,
} from "lucide-react";

import {
  MobileCategoryAccordion,
  type MobileCategory,
} from "@/storefront/components/storefront/mobile-category-accordion";
import { ViewAllLink } from "@/storefront/components/storefront/section-heading";
import { capsuleBar, chip, iconBtn } from "@/storefront/components/storefront/ui-classes";
import { useCartCount } from "@/storefront/lib/cart";
import { products, slugify, type Product } from "@/storefront/lib/catalog";
import { promoIcon } from "@/lib/links/promo-icons";
import type { LucideIcon } from "lucide-react";
import type { NavImageAspect, NavBlockSize } from "@/lib/cms/nav-composer-model";
import {
  EMPTY_HEADER_NAV,
  type NavMenuProduct,
  type NavMenuSection,
  type NavMenuBanner,
  type TokyoHeaderNav,
} from "@/storefront/lib/header-nav-model";
import { useFavoriteCount } from "@/storefront/lib/favorites";
import { useSiteContacts, telHref } from "@/storefront/lib/site-contacts";
import { useProductBar } from "@/storefront/lib/productBar";
import { prefersReducedMotion } from "@/storefront/lib/motion";
import { productStrike, fmtPrice } from "@/storefront/lib/productMeta";
import { cn } from "@/storefront/lib/utils";

const searchSuggestions = [
  "iPhone occasion",
  "iPhone 18 Pro Max",
  "GTA 6",
  "EA FC 27",
  "MacBook Air M3",
  "AirPods Pro 2",
  "Apple Watch Series 9",
  "iPad Pro M4",
];

const popularSearches = [
  "iPhone 18 Pro Max",
  "MacBook Air M3",
  "AirPods Pro 2",
  "iPad Pro M4",
  "Apple Watch Series 10",
];

/** Title keys for the live search, computed once rather than on every keystroke. */
const searchKeys = products.map((p) => slugify(p.title));

/**
 * Only runs while `active` (the search overlay is open and empty): it used to
 * tick every 45–90ms for the life of the page, re-rendering the whole header.
 */
function useTypewriter(
  words: string[],
  active: boolean,
  typingMs = 90,
  deletingMs = 45,
  pauseMs = 1400,
) {
  const [text, setText] = useState("");
  const [wordIndex, setWordIndex] = useState(0);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    if (!active) return;
    const word = words[wordIndex % words.length];
    if (!deleting && text === word) {
      const t = setTimeout(() => setDeleting(true), pauseMs);
      return () => clearTimeout(t);
    }
    if (deleting && text === "") {
      setDeleting(false);
      setWordIndex((i) => (i + 1) % words.length);
      return;
    }
    const t = setTimeout(
      () => {
        setText((cur) =>
          deleting ? word.slice(0, cur.length - 1) : word.slice(0, cur.length + 1),
        );
      },
      deleting ? deletingMs : typingMs,
    );
    return () => clearTimeout(t);
  }, [active, text, deleting, wordIndex, words, typingMs, deletingMs, pauseMs]);

  return text;
}

/** matchMedia as React state. The server (and the hydration pass) render `false`. */
function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const mq = window.matchMedia(query);
      mq.addEventListener("change", onChange);
      return () => mq.removeEventListener("change", onChange);
    },
    [query],
  );
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => false,
  );
}

/**
 * The shop serves PrestaShop image types. A 44–56px thumbnail needs the 125px
 * "small_default" (≈1.5 KB), not the ~770px "large_default" (≈14 KB) the
 * catalogue points at; 370px covers 3× screens.
 */
function thumbSrcSet(src: string): string | undefined {
  if (!src.includes("-large_default/")) return undefined;
  return `${src.replace("-large_default/", "-small_default/")} 125w, ${src.replace("-large_default/", "-home_default/")} 370w`;
}

/**
 * Quick links shown inside the nav pill on large screens (and as the chip row
 * of the mobile menu). The centre group has to stay exactly centred between
 * the logo group and the icon group, so the lowest-priority links step out
 * instead of shrinking: three at 1024, five from 1200, six from 1280. Each
 * step keeps at least ~38px between the last link and the search button (at
 * 1152 five links left only 16px). On touch the targets are 44px capsules
 * 8px apart, which is ~31px wider, so each link steps in one width later.
 */
const showFrom1200 = "hidden min-[1200px]:pointer-fine:list-item xl:list-item";
const showFrom1280 = "hidden xl:pointer-fine:list-item min-[1360px]:list-item";
/** Which shortcut pills step out of the centre group by width, BY POSITION: the
 *  first three always show, the next two from 1200, the rest from 1280 — so the
 *  group stays centred whatever shortcuts the builder defines. On touch each
 *  steps in one width later (baked into the classes). The shortcut links + the
 *  mobile « Service client » links are now builder-managed (passed as props). */
function shortcutShow(index: number): string | undefined {
  if (index < 3) return undefined;
  if (index < 5) return showFrom1200;
  return showFrom1280;
}

/**
 * A universe panel, hydrated from the server DTO (the builder-driven nav): `icon`
 * is a lucide component resolved from the stored PROMO_ICON_MAP name; the rest is
 * the DTO as-is. The STRUCTURE (universes → sections → chips + products + banner)
 * now comes from Contenu & Design → Menu de navigation, not the taxonomy.
 */
type MegaCategory = {
  key: string;
  label: string;
  blurb: string;
  icon: LucideIcon;
  /** « Voir tout » target. */
  href: string;
  sections: NavMenuSection[];
  products: NavMenuProduct[];
  banner: NavMenuBanner | null;
};

/** Resolve a universe/shortcut icon NAME (PROMO_ICON_MAP) → a lucide component;
 *  LayoutGrid is the safe fallback for a missing / unknown name. */
function navIcon(name: string | null): LucideIcon {
  return promoIcon(name) ?? LayoutGrid;
}

/** Banner FORMAT → CSS aspect ratio + panel WIDTH by size (the featured side
 *  panel of a universe menu — mirrors the catalog image aspect/size scale). */
const NAV_ASPECT_CLASS: Record<NavImageAspect, string> = {
  landscape: "aspect-[4/3]",
  square: "aspect-square",
  portrait: "aspect-[3/4]",
  long: "aspect-[2/3]",
  longer: "aspect-[9/16]",
};
const NAV_BANNER_WIDTH: Record<NavBlockSize, string> = {
  sm: "w-[220px]",
  md: "w-[260px]",
  lg: "w-[300px]",
};

/** "You are here" on pill links and icons: the reference's accent tint. */
const currentTint = "aria-[current=page]:bg-primary/10 aria-[current=page]:text-primary-ink";

/**
 * Cart / favourites count on an icon button: the bottom nav's badge recipe, a
 * 16px disc that grows into a capsule for two or three digits (a fixed 16px
 * circle crammed "12" edge to edge). Position it at the call site.
 */
const countBadge =
  "grid h-4 min-w-4 place-items-center rounded-full bg-primary px-1 text-[10px] font-bold text-primary-foreground tabular-nums";

/**
 * Focus for the search capsules (the md+ pill in search mode, the phone
 * overlay's bar): the `field` recipe, i.e. a 2px ring-colour outline over the
 * hairline plus the soft 15% halo, drawn on the capsule since the bare input
 * has no box of its own. Keyed to the input, not focus-within, so a focused
 * button or result inside keeps its own outline alone.
 */
const searchFieldFocus =
  "has-[input:focus-visible]:border-primary has-[input:focus-visible]:outline-2 has-[input:focus-visible]:-outline-offset-1 has-[input:focus-visible]:outline-ring has-[input:focus-visible]:ring-4 has-[input:focus-visible]:ring-primary/15";

/**
 * Sub-category chips inside the mega menu. 26px at a desk; a full 44px on
 * touch tablets, where the menu is tapped rather than hovered (the panel then
 * grows or scrolls to fit).
 */
const megaChip =
  "block w-fit max-w-full truncate rounded-full border border-border bg-surface px-2.5 py-1 text-[12px] leading-[18px] font-medium text-foreground transition-colors duration-200 hover:border-primary/40 hover:bg-primary/5 hover:text-primary pointer-coarse:px-3.5 pointer-coarse:py-3";

/** The pill's two firmer shadows are the reference's own values and stay literal. */
const bannerRestShadow = "lg:shadow-[0_10px_30px_-14px_rgba(15,15,15,0.35)]";

/**
 * "Dynamic Island" opening. The pill itself grows into the panel it opens
 * (mega menu, desktop search) and the phone menu grows out of a pill-sized
 * capsule, keeping its own radius, hairline and shadow the whole way, so it
 * reads as the pill filling that space. The motion is a lightly damped spring
 * (damping ratio 0.82): a quick start, then a ~1% overshoot of the final size
 * (about 5px on the mega menu) that settles back, the very small elastic
 * "landing". Sampled into a CSS linear() easing; browsers without linear()
 * keep ease-soft. Closing stays on ease-soft: a spring would dip below the
 * bar's own height and clip it. The pill's own entrance on load is the CSS
 * `nav-island` animation in globals.css.
 */
function springEasing(damping: number, samples = 40): string {
  // Natural frequency such that the wobble has decayed to 0.1% at t = 1.
  const w = Math.log(1000) / damping;
  const wd = w * Math.sqrt(1 - damping * damping);
  const points: string[] = [];
  for (let i = 0; i < samples; i++) {
    const t = i / samples;
    const x =
      1 - Math.exp(-damping * w * t) * (Math.cos(wd * t) + ((damping * w) / wd) * Math.sin(wd * t));
    points.push(x.toFixed(4));
  }
  return `linear(${points.join(", ")}, 1)`;
}
const islandEasing = springEasing(0.82);
const islandMs = 700;

/** The island a sheet grows out of: the size the pill starts at on load. */
const ISLAND_W = 120;
const ISLAND_H = 36;

/**
 * Plays the island opening on a fixed sheet that has just rendered at its
 * open size: it starts as a small capsule centred at its top edge and grows
 * sideways and down into place on the spring. Its real box is animated (the
 * left/right insets and the height, never a scale), so its radius, hairline
 * and shadow stay its own. Web Animations, because the open height is the
 * content's; max-height is lifted for the run so the overshoot isn't clipped
 * by the viewport cap.
 */
function islandGrow(el: HTMLElement) {
  if (prefersReducedMotion()) return;
  const cs = getComputedStyle(el);
  const { width, height } = el.getBoundingClientRect();
  if (height <= ISLAND_H) return;
  const inset = Math.max(0, (width - ISLAND_W) / 2);
  const frames = [
    {
      left: `calc(${cs.left} + ${inset}px)`,
      right: `calc(${cs.right} + ${inset}px)`,
      height: `${ISLAND_H}px`,
      maxHeight: "none",
    },
    { left: cs.left, right: cs.right, height: `${height}px`, maxHeight: "none" },
  ];
  try {
    el.animate(frames, { duration: islandMs, easing: islandEasing });
  } catch {
    // An easing the browser cannot parse throws: fall back to ease-soft.
    el.animate(frames, { duration: islandMs, easing: "cubic-bezier(0.22, 1, 0.36, 1)" });
  }
}

export function Header({
  logoUrl,
  brandName,
  nav = EMPTY_HEADER_NAV,
}: {
  /** Médiathèque logo (site.logo_media_id) → falls back to the bundled mark. */
  logoUrl?: string | null;
  /** site.name → the logo's alt text. */
  brandName?: string | null;
  /** Builder-driven header nav (universes + shortcuts + service), from
   *  getTokyoHeaderNav in the (tokyo) layout. Empty → the menu degrades quietly. */
  nav?: TokyoHeaderNav;
} = {}) {
  const logoSrc = logoUrl?.trim() || "/tokyo-logo.png";
  const logoAlt = brandName?.trim() || "Tokyo Store";
  const router = useRouter();
  const pathname = usePathname();
  const cartCount = useCartCount();
  const favCount = useFavoriteCount();
  const { phone: sitePhone } = useSiteContacts();
  const pb = useProductBar();
  const hiddenByProductBar = pb.active && pb.view === "product";

  const [megaOpen, setMegaOpen] = useState(false);
  // Default to Apple, the richest universe: "Univers Tokyo" opened on four chips.
  const [activeMega, setActiveMega] = useState(1);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [scrolled, setScrolled] = useState(false);
  // Strictly unscrolled. `scrolled` has a 10–80px dead zone, which is right
  // for the pill's size but not for anything sized to the banner.
  const [atTop, setAtTop] = useState(true);
  // Desktop search: the whole nav pill turns into a search field in place.
  const [inlineSearch, setInlineSearch] = useState(false);
  // Set on the first sign of intent (pointer on the pill, focus on the
  // trigger) so the preview thumbnails are already loading when it opens.
  const [megaWarm, setMegaWarm] = useState(false);
  const warmUp = () => setMegaWarm(true);

  const typed = useTypewriter(searchSuggestions, searchOpen && !searchQuery);

  // Builder-driven header nav, hydrated from the server DTO: universe icons
  // resolve to lucide components, everything else passes through. The mobile
  // accordion, centre pills and mobile service links all derive from the same
  // source, so one edit in the nav builder updates every surface.
  const megaMenu: MegaCategory[] = useMemo(
    () =>
      nav.universes.map((u) => ({
        key: u.key,
        label: u.label,
        blurb: u.blurb,
        icon: navIcon(u.icon),
        href: u.href,
        sections: u.sections,
        products: u.products,
        banner: u.banner,
      })),
    [nav.universes],
  );
  const mobileCategories: MobileCategory[] = useMemo(
    () =>
      megaMenu.map((c) => ({
        label: c.label,
        icon: c.icon,
        href: c.href,
        sections: c.sections.map((s) => ({
          title: s.title,
          href: s.href,
          items: s.items.map((l) => ({ label: l.label, href: l.href })),
        })),
      })),
    [megaMenu],
  );
  const navShortcuts = useMemo(
    () =>
      nav.shortcuts.map((s, i) => ({
        label: s.label,
        icon: promoIcon(s.icon),
        accent: s.accent,
        href: s.href,
        show: shortcutShow(i),
      })),
    [nav.shortcuts],
  );
  const serviceLinks = nav.service;
  // Reserve the featured-banner column's width whenever ANY universe has one, so
  // switching universes never reflows the panel (stable content width).
  const anyBanner = useMemo(() => megaMenu.some((u) => u.banner), [megaMenu]);

  // From lg up the pill floats inside the home hero until the page scrolls
  // (below lg the hero starts 12px under the band, on the beige canvas).
  const onBanner = pathname === "/" && !scrolled;
  // Only from 1280px is the banner tall enough to hold the open menu; below
  // that, home uses the content-driven height like every other route. It must
  // also be exactly in place: opened after a 70px scroll, a banner-sized menu
  // ran 58px past the banner's bottom edge (the pill had not collapsed yet).
  const isXl = useMediaQuery("(min-width: 1280px)");
  const isLg = useMediaQuery("(min-width: 1024px)");
  const menuOverBanner = pathname === "/" && atTop && isXl;

  /**
   * State and CSS media queries must never disagree about these panels. The
   * mobile dropdown is `md:hidden` but its body-scroll lock is state-only, so
   * crossing 768 with it open (an iPhone rotating to landscape) left the page
   * permanently unscrollable with no visible control to clear it. The mega
   * menu and the inline search are the mirror image: md+ panels whose state
   * would outlive a rotation down to a phone. All are closed on the
   * breakpoint change, and on navigation.
   */
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(min-width: 768px)");
    const sync = () => {
      if (mq.matches) setMobileOpen(false);
      else {
        setMegaOpen(false);
        setInlineSearch(false);
      }
    };
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    setMobileOpen(false);
    setMegaOpen(false);
    setSearchOpen(false);
    setInlineSearch(false);
    setSearchQuery("");
  }, [pathname]);

  const searchInputRef = useRef<HTMLInputElement>(null);
  const inlineInputRef = useRef<HTMLInputElement>(null);
  // Hover-intent timers for the mega menu (see "Mega menu" below).
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dwellTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tabTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const openedAt = useRef(0);
  const megaTriggerRef = useRef<HTMLButtonElement>(null);
  const railTabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const menuBtnRef = useRef<HTMLButtonElement>(null);
  const menuDialogRef = useRef<HTMLElement>(null);
  const searchTriggerRef = useRef<HTMLButtonElement>(null);
  const restoreSearchFocus = useRef(false);
  const searchReturnRef = useRef<HTMLElement | null>(null);

  /**
   * The mobile dropdown hangs 12px under the pill (the same inset as the pill
   * inside the banner), and the pill moves as the bar collapses on scroll and
   * as the safe-area inset applies, so the offset is measured, not assumed.
   */
  const blocRef = useRef<HTMLDivElement>(null);
  const [dropTop, setDropTop] = useState(92);
  useEffect(() => {
    if (!mobileOpen) return;
    const measure = () => {
      const r = blocRef.current?.getBoundingClientRect();
      if (r) setDropTop(Math.round(r.bottom + 12));
    };
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, { passive: true });
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure);
    };
  }, [mobileOpen, scrolled]);

  /* The sheet grows out of an island as it opens (see islandGrow). A layout
     effect, so the first painted frame is already the small capsule rather
     than the full sheet. Its top is measured in the menu button's handler,
     in the same render that opens it, so the size measured here is final. */
  useLayoutEffect(() => {
    if (mobileOpen && menuDialogRef.current) islandGrow(menuDialogRef.current);
  }, [mobileOpen]);

  /**
   * The open panel's height is its natural content height: nav row + the
   * pill's 2px of border + the panel's 1px hairline + the taller of the two
   * columns, each measured from an unstretched inner wrapper (measuring the
   * stretched column made the height ratchet and left a dead band), and
   * capped 36px short of the viewport (24px above, 12px below).
   *
   * Every universe is rendered stacked into a single grid cell (see the panel
   * below), so this one measurement is the TALLEST universe's requirement and
   * all of them share it: switching universes never resizes the panel. It is
   * taken while the menu is still closed, so the first open already animates
   * from the pill's height to the right value.
   *
   * Over the banner the height is the banner's instead, but only when the
   * columns fit in it: on a touch tablet (1366 landscape) the 44px chips need
   * ~90px more than the banner has, and a banner-bounded panel hid them behind
   * a scroll. It then falls back to the content height like every other
   * route. Over the banner the preview row only shows when it fits under the
   * columns (at 1920 it does, at 1280 and 1440 it doesn't). The banner's
   * height is read from a probe element so CSS stays the single source for
   * --menu-h-banner.
   */
  const navRowRef = useRef<HTMLDivElement>(null);
  const railRef = useRef<HTMLDivElement>(null);
  const railInnerRef = useRef<HTMLDivElement>(null);
  const menuContentRef = useRef<HTMLDivElement>(null);
  const menuInnerRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const bannerProbeRef = useRef<HTMLDivElement>(null);
  const previewHeight = useRef(0);
  const [menuNeeded, setMenuNeeded] = useState<number | null>(null);
  const [previewFits, setPreviewFits] = useState(true);
  const [fitsBanner, setFitsBanner] = useState(true);
  const bannerMenu = menuOverBanner && fitsBanner;

  useEffect(() => {
    const padY = (el: HTMLElement) => {
      const cs = getComputedStyle(el);
      return parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    };
    const measure = () => {
      const row = navRowRef.current;
      const col = menuContentRef.current;
      const inner = menuInnerRef.current;
      const rail = railRef.current;
      const railInner = railInnerRef.current;
      // Phones and the inline search don't lay the panel out at all.
      if (!row || !col || !inner || !rail || !railInner || !inner.offsetHeight) return;
      // The preview row (its pt-5 lead included) is remembered while hidden,
      // so the fit check below still knows what showing it would cost.
      const preview = previewRef.current;
      const shownPreview = preview?.offsetHeight ?? 0;
      if (shownPreview) previewHeight.current = shownPreview;
      const chrome = row.offsetHeight + 2 + 1;
      const columns = inner.offsetHeight + padY(col);
      const railNeeded = railInner.offsetHeight + padY(rail);
      const cap = window.innerHeight - 36;
      setMenuNeeded(Math.min(chrome + Math.max(columns + shownPreview, railNeeded), cap));
      const probe = bannerProbeRef.current;
      const fits = !!probe && probe.offsetHeight >= chrome + Math.max(columns, railNeeded);
      setFitsBanner(fits);
      if (menuOverBanner && fits && probe) {
        const room = Math.min(probe.offsetHeight, cap) - chrome - columns;
        setPreviewFits(room >= previewHeight.current);
      } else {
        setPreviewFits(true);
      }
    };
    measure();
    const ro = new ResizeObserver(measure);
    for (const el of [navRowRef, railInnerRef, menuInnerRef, previewRef, bannerProbeRef]) {
      if (el.current) ro.observe(el.current);
    }
    window.addEventListener("resize", measure);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [menuOverBanner, inlineSearch]);

  // Mega-menu content for the active universe + its preview row — both set in the
  // nav builder (the universe's own products, via its `products` block). Clamped
  // so a shorter menu (or an out-of-range index) never reads past the array.
  const activeUniverse = megaMenu[activeMega] ?? megaMenu[0];
  const previewProducts = activeUniverse?.products ?? [];
  const activeBanner = activeUniverse?.banner ?? null;

  // Live results from the local catalogue, shared by the desktop and mobile search.
  const searchKey = slugify(searchQuery);
  const hasQuery = searchKey.length >= 2;
  const results = useMemo(() => {
    if (searchKey.length < 2) return [];
    const out: Product[] = [];
    for (let i = 0; i < products.length && out.length < 6; i++) {
      if (searchKeys[i].includes(searchKey)) out.push(products[i]);
    }
    return out;
  }, [searchKey]);

  /* ---------------------------------------------------------------------------
     Mega menu: hover opens it for a real mouse only; on touch and keyboard the
     button's click is the one toggle. Touch taps also fire enter/focus events,
     which used to open the menu a few ms before the click toggled it shut.
     Hover acts on INTENT, not contact, so a pointer merely passing by changes
     nothing:
     - the trigger opens the menu after a 150ms dwell (sweeping from the logo to
       the shortcuts crossed it in ~80ms and dropped a 547px panel over the page);
     - until the pointer has been inside the panel, resting 300ms on another
       control of the nav row (shortcut, icon, logo) closes it again. Crossing a
       shortcut on the way down into the panel takes far less than that;
     - a universe tab takes over after a 120ms dwell, so a diagonal move from
       the rail to a chip does not switch universes under the pointer on its way
       across the tabs below. Clicks, keys and taps all stay immediate.
  --------------------------------------------------------------------------- */
  const clearTimer = (t: { current: ReturnType<typeof setTimeout> | null }) => {
    if (t.current) clearTimeout(t.current);
    t.current = null;
  };
  const panelVisited = useRef(false);
  const openMega = () => {
    clearTimer(closeTimer);
    clearTimer(openTimer);
    if (!megaOpen) panelVisited.current = false;
    setMegaWarm(true);
    setMegaOpen(true);
  };
  const scheduleClose = () => {
    clearTimer(closeTimer);
    closeTimer.current = setTimeout(() => setMegaOpen(false), 120);
  };
  const onTriggerPointerEnter = (e: ReactPointerEvent) => {
    if (e.pointerType !== "mouse" || megaOpen) return;
    clearTimer(openTimer);
    openTimer.current = setTimeout(() => {
      // Only a hover open starts the click-confirm window (see toggleMega).
      openedAt.current = Date.now();
      openMega();
    }, 150);
  };
  const onTriggerPointerLeave = () => clearTimer(openTimer);
  /** Spread on the nav row's other controls (logo, shortcuts, icons). */
  const dwellClose = {
    onPointerEnter: (e: ReactPointerEvent) => {
      if (e.pointerType !== "mouse" || !megaOpen || panelVisited.current) return;
      clearTimer(dwellTimer);
      dwellTimer.current = setTimeout(() => setMegaOpen(false), 300);
    },
    onPointerLeave: () => clearTimer(dwellTimer),
  };
  const onPanelPointerEnter = (e: ReactPointerEvent) => {
    if (e.pointerType !== "mouse") return;
    panelVisited.current = true;
    clearTimer(dwellTimer);
    openMega();
  };
  const onTabPointerEnter = (e: ReactPointerEvent, idx: number) => {
    if (e.pointerType !== "mouse") return;
    clearTimer(tabTimer);
    tabTimer.current = setTimeout(() => setActiveMega(idx), 120);
  };
  const onTabPointerLeave = () => clearTimer(tabTimer);
  useEffect(
    () => () => {
      for (const t of [closeTimer, openTimer, dwellTimer, tabTimer]) {
        if (t.current) clearTimeout(t.current);
      }
    },
    [],
  );
  // A click within 600ms of a hover open confirms the menu rather than closing
  // it; a click during the hover dwell simply opens it now.
  // Opened from the keyboard (Enter/Space fire a click with detail 0), focus
  // goes straight to the rail: in DOM order the panel sits after the six
  // shortcuts and five icons, 12 Tab stops away from its trigger.
  const toggleMega = (e: ReactMouseEvent<HTMLButtonElement>) => {
    if (megaOpen) {
      if (Date.now() - openedAt.current >= 600) setMegaOpen(false);
      return;
    }
    openMega();
    if (e.detail === 0) {
      requestAnimationFrame(() => railTabRefs.current[activeMega]?.focus({ preventScroll: true }));
    }
  };
  // ArrowDown on the trigger jumps straight into the universe rail.
  const onTriggerKeyDown = (e: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (e.key !== "ArrowDown") return;
    e.preventDefault();
    openMega();
    requestAnimationFrame(() => railTabRefs.current[activeMega]?.focus({ preventScroll: true }));
  };
  // Roving focus through the rail (a vertical tablist): arrows, Home and End.
  const onRailKeyDown = (e: ReactKeyboardEvent<HTMLUListElement>) => {
    const n = megaMenu.length;
    const from = railTabRefs.current.findIndex((el) => el === document.activeElement);
    const cur = from === -1 ? activeMega : from;
    let next: number;
    if (e.key === "ArrowDown") next = (cur + 1) % n;
    else if (e.key === "ArrowUp") next = (cur - 1 + n) % n;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = n - 1;
    else return;
    e.preventDefault();
    setActiveMega(next);
    railTabRefs.current[next]?.focus({ preventScroll: true });
  };

  // While open, the menu closes on Escape (focus back on the trigger), on a
  // press or focus outside the pill, and once the page scrolls away (48px).
  useEffect(() => {
    if (!megaOpen) return;
    const bloc = blocRef.current;
    const openY = window.scrollY;
    const close = () => setMegaOpen(false);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      close();
      megaTriggerRef.current?.focus({ preventScroll: true });
    };
    const onPointerDown = (e: PointerEvent) => {
      if (bloc && !bloc.contains(e.target as Node)) close();
    };
    // relatedTarget is null when the window itself loses focus: stay open then.
    const onFocusOut = (e: FocusEvent) => {
      const next = e.relatedTarget;
      if (bloc && next instanceof Node && !bloc.contains(next)) close();
    };
    const onScroll = () => {
      if (Math.abs(window.scrollY - openY) > 48) close();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointerDown);
    bloc?.addEventListener("focusout", onFocusOut);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointerDown);
      bloc?.removeEventListener("focusout", onFocusOut);
      window.removeEventListener("scroll", onScroll);
    };
  }, [megaOpen]);

  /* ---------------------------------------------------------------------------
     Search. Desktop: the pill turns into a field with suggestions/results
     beneath it, inside the same bloc. Mobile: a full-screen dialog whose bar
     sits exactly where the pill was.
  --------------------------------------------------------------------------- */
  const openInlineSearch = () => {
    setMegaOpen(false);
    setInlineSearch(true);
  };
  const closeInlineSearch = useCallback((restoreFocus: boolean) => {
    restoreSearchFocus.current = restoreFocus;
    setInlineSearch(false);
    setSearchQuery("");
  }, []);
  // Focused without scrolling: autoFocus would scroll the sticky pill's field
  // "into view" and jump the page under it.
  useEffect(() => {
    if (inlineSearch) inlineInputRef.current?.focus({ preventScroll: true });
  }, [inlineSearch]);
  useEffect(() => {
    if (inlineSearch || !restoreSearchFocus.current) return;
    restoreSearchFocus.current = false;
    searchTriggerRef.current?.focus({ preventScroll: true });
  }, [inlineSearch]);
  // Escape (focus back on the trigger), a press outside the pill, or focus
  // leaving it closes it. Without the focusout, tabbing past the last result
  // left the grown pill covering the element that had just taken focus.
  useEffect(() => {
    if (!inlineSearch) return;
    const bloc = blocRef.current;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeInlineSearch(true);
    };
    const onPointerDown = (e: PointerEvent) => {
      if (bloc && !bloc.contains(e.target as Node)) closeInlineSearch(false);
    };
    // relatedTarget is null when the window itself loses focus: stay open then.
    const onFocusOut = (e: FocusEvent) => {
      const next = e.relatedTarget;
      if (bloc && next instanceof Node && !bloc.contains(next)) closeInlineSearch(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointerDown);
    bloc?.addEventListener("focusout", onFocusOut);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointerDown);
      bloc?.removeEventListener("focusout", onFocusOut);
    };
  }, [inlineSearch, closeInlineSearch]);

  const [searchOrigin, setSearchOrigin] = useState<{ x: number; y: number } | null>(null);
  const openSearchOverlay = useCallback(
    (origin: { x: number; y: number } | null, opener: Element | null) => {
      searchReturnRef.current = opener instanceof HTMLElement ? opener : null;
      setSearchOrigin(origin);
      setSearchOpen(true);
    },
    [],
  );
  const closeSearchOverlay = useCallback(() => {
    setSearchOpen(false);
    setSearchQuery("");
  }, []);

  // The bottom nav's search tab opens the overlay through this event.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { x?: number; y?: number } | undefined;
      const origin =
        detail && typeof detail.x === "number" && typeof detail.y === "number"
          ? { x: detail.x, y: detail.y }
          : null;
      openSearchOverlay(origin, document.activeElement);
    };
    window.addEventListener("tokyo:open-search", handler);
    return () => window.removeEventListener("tokyo:open-search", handler);
  }, [openSearchOverlay]);

  useEffect(() => {
    if (!searchOpen) return;
    const t = setTimeout(() => searchInputRef.current?.focus({ preventScroll: true }), 220);
    return () => clearTimeout(t);
  }, [searchOpen]);

  // Enter commits to the full search results page (/recherche) — the live
  // dropdown above stays instant (local catalogue), the committed search is the
  // backend-powered page. Mirrors the min-length gate of the local results.
  const submitSearch = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const q = searchQuery.trim();
    if (q.length < 2) return;
    router.push(`/recherche?q=${encodeURIComponent(q)}`);
    if (inlineSearch) closeInlineSearch(false);
    else closeSearchOverlay();
  };

  /**
   * A suggestion fills the field and hands focus back to it: the results
   * replace the chip that had focus, which dropped it to <body>. Not after a
   * tap on a touch screen, where focusing the field raises the keyboard over
   * the results it just produced.
   */
  const pickSuggestion = (
    s: string,
    e: ReactMouseEvent,
    field: RefObject<HTMLInputElement | null>,
  ) => {
    setSearchQuery(s);
    if (e.detail === 0 || !window.matchMedia("(pointer: coarse)").matches) {
      field.current?.focus({ preventScroll: true });
    }
  };

  /* ---------------------------------------------------------------------------
     Mobile menu (a disclosure of the pill) and search overlay (a modal
     dialog): Escape closes them, the page behind is inert and scroll-locked,
     focus moves in on open and back to the opener on close. The bottom nav
     slides away while the menu is open (html[data-menu-open], see
     globals.css) so the sheet gets a symmetric 12px frame.
  --------------------------------------------------------------------------- */
  useEffect(() => {
    if (!mobileOpen && !searchOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (searchOpen) closeSearchOverlay();
      else setMobileOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mobileOpen, searchOpen, closeSearchOverlay]);

  useEffect(() => {
    document.body.style.overflow = mobileOpen || searchOpen ? "hidden" : "";
    return () => {
      document.body.style.overflow = "";
    };
  }, [mobileOpen, searchOpen]);

  useEffect(() => {
    if (!mobileOpen && !searchOpen) return;
    const behind = [
      ...document.querySelectorAll<HTMLElement>("main, footer, [data-bottom-nav]"),
    ].filter((el) => !el.inert);
    for (const el of behind) el.inert = true;
    return () => {
      for (const el of behind) el.inert = false;
    };
  }, [mobileOpen, searchOpen]);

  useEffect(() => {
    if (!mobileOpen) return;
    const root = document.documentElement;
    root.dataset.menuOpen = "true";
    return () => {
      delete root.dataset.menuOpen;
    };
  }, [mobileOpen]);

  const wasMobileOpen = useRef(false);
  useEffect(() => {
    if (mobileOpen) {
      menuDialogRef.current
        ?.querySelector<HTMLElement>("a[href], button")
        ?.focus({ preventScroll: true });
    } else if (wasMobileOpen.current) {
      menuBtnRef.current?.focus({ preventScroll: true });
    }
    wasMobileOpen.current = mobileOpen;
  }, [mobileOpen]);

  const wasSearchOpen = useRef(false);
  useEffect(() => {
    if (!searchOpen && wasSearchOpen.current) {
      searchReturnRef.current?.focus({ preventScroll: true });
      searchReturnRef.current = null;
    }
    wasSearchOpen.current = searchOpen;
  }, [searchOpen]);

  useEffect(() => {
    let raf = 0;
    // Hysteresis: collapse only past COLLAPSE_AT, re-expand only under EXPAND_AT.
    // The dead zone (10–80px) keeps the pill from flickering between its two
    // sizes when the page settles right at a single threshold.
    const COLLAPSE_AT = 80;
    const EXPAND_AT = 10;
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        const y = window.scrollY;
        setScrolled((prev) => (prev ? y > EXPAND_AT : y > COLLAPSE_AT));
        setAtTop(y < 1);
        raf = 0;
      });
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  const current = (href: string) => (pathname === href ? ("page" as const) : undefined);

  /* Two resting shadow strengths. Floating inside the hero banner the pill
     sits on photography that changes with every slide, so it keeps the
     original, firmer shadow to stay separated. Anywhere else it sits on the
     beige canvas, where that same shadow read as a dark halo, hence the
     softer one. */
  const restShadow = scrolled ? "shadow-pill" : cn("shadow-float", onBanner && bannerRestShadow);
  /* Grown over the page (menu or search suggestions), the bloc takes an open
     shadow: the firm one only while it sits inside the photography. The menu
     is banner-bounded only from 1280px, so below that (or when its columns
     outgrow the banner) it hangs onto the beige canvas and takes the soft one.
     The search dropdown (at most ~420px) follows the resting pill's rule. */
  const inPhoto = inlineSearch ? onBanner && isLg : bannerMenu;
  const openShadow = inPhoto
    ? "shadow-[0_34px_80px_-34px_rgba(15,15,15,0.5)]"
    : "shadow-[0_28px_70px_-36px_rgba(15,15,15,0.3)]";
  const pillState = inlineSearch
    ? // The suggestions grow the pill in place; no height animation.
      cn("h-auto", openShadow)
    : megaOpen
      ? cn("max-h-[calc(100dvh-2.25rem)]", bannerMenu && "h-(--menu-h-banner)", openShadow)
      : cn(scrolled ? "h-14" : "h-14 md:h-16", restShadow);

  const revealStyle = searchOrigin
    ? ({
        "--reveal-x": `${searchOrigin.x}px`,
        "--reveal-y": `${searchOrigin.y}px`,
      } as CSSProperties)
    : undefined;

  return (
    <>
      {/* Skip link: the first Tab stop on every route, ahead of the 13 in the
          pill. Outside <header> because the header goes aria-hidden while the
          product page's capsule holds its slot. Inert behind the overlays,
          where the page it skips to is inert too. Parked a viewport-height
          above the screen until focused (whatever the safe-area inset),
          rather than shrunk to sr-only's 1px box. */}
      <a
        href="#contenu"
        inert={mobileOpen || searchOpen}
        className={cn(
          chip.base,
          chip.lg,
          chip.neutral,
          "fixed top-[calc(0.75rem+env(safe-area-inset-top))] left-(--gutter-l) z-[120] font-semibold shadow-float not-focus-visible:-top-full",
        )}
      >
        Aller au contenu
      </a>

      {/* Floating nav pill.
          The sticky band is transparent and click-through: only the pill takes
          pointer events. The band's in-flow height NEVER changes (not on
          scroll, not when the product page's own capsule takes over), so
          nothing below it ever shifts. On the home page, from lg, the hero
          banner is pulled up underneath it (see hero-carousel), so the pill
          floats inside the banner with an even gap on every side. */}
      <header
        data-scrolled={scrolled ? "true" : "false"}
        aria-hidden={hiddenByProductBar}
        inert={searchOpen}
        /* The band absorbs the iOS safe-area inset, so on notched devices the
           pill (and the banner pulled up beneath it) start below the notch
           while keeping the same 12px gap. Once scrolled, a beige fade masks
           the 12px strip above the pill, where page content used to show
           through (the band is click-through, so it only paints). */
        className={cn(
          /* justify-center: the pill is w-full, so this only matters during
             the load entrance, where it keeps the island centred and its
             overshoot even on both sides. */
          "gutter-x pointer-events-none sticky top-0 flex h-[calc(var(--nav-h)+env(safe-area-inset-top))] items-start justify-center transition-[padding] duration-[420ms] ease-soft",
          /* Raised whenever the bloc grows over the page, so no fixed layer
             paints over it (the product page's z-55 price pill covered the
             open menu's corner on short screens). Nothing modal (z-100/110)
             can be open at the same time. */
          mobileOpen || megaOpen || inlineSearch ? "z-[100]" : "z-50",
          scrolled
            ? "pt-[calc(0.75rem+env(safe-area-inset-top))]"
            : "pt-[calc(1.5rem+env(safe-area-inset-top))]",
          /* Kept while the product page's capsule holds the slot: it sits in
             the scrolled pill's box, so the same strip above it needs masking.
             Dropped while the phone menu is open: the band sits above its
             scrim, and the fade left a bright strip over the dimmed page. */
          scrolled &&
            !mobileOpen &&
            "bg-linear-to-b from-surface-beige via-surface-beige/70 to-transparent",
        )}
      >
        {/* Resolves --menu-h-banner to pixels for the preview-row fit check. */}
        <div
          ref={bannerProbeRef}
          aria-hidden
          className="pointer-events-none invisible absolute top-0 left-0 h-(--menu-h-banner) w-px"
        />
        <div
          ref={blocRef}
          inert={hiddenByProductBar}
          onPointerEnter={warmUp}
          onPointerLeave={(e) => {
            if (e.pointerType === "mouse") scheduleClose();
          }}
          style={{
            /* Over the hero (from 1280px, when the columns fit) the panel is
               sized by the BANNER so it stops the same 12px short of its
               bottom edge as it sits from the top and sides. Everywhere else
               the explicit pixel height is what the open animation runs to. */
            ...(megaOpen && !inlineSearch && !bannerMenu && menuNeeded
              ? { height: `${menuNeeded}px` }
              : null),
            /* Opening runs on the island spring (the transition takes the
               timing of the state it moves TO); closing falls back to the
               class's ease-soft. An unsupported linear() is simply ignored. */
            ...(megaOpen && !inlineSearch
              ? { transitionTimingFunction: islandEasing, transitionDuration: `${islandMs}ms` }
              : null),
          }}
          /* The radius is CONSTANT (32px) and never animated: CSS clamps it to
             half the box, so the closed bar is a perfect pill (h-16 -> 32px,
             h-14 -> clamped to 28px) and it becomes a rounded rectangle on its
             own as the height grows. Animating border-radius from `rounded-full`
             instead interpolates 9999px -> 28px, which renders as an oval for
             most of the transition and then snaps.
             On the product page the pill fades out in place while the page's
             own capsule takes the slot (visibility is transitioned too, so the
             fade plays before it stops painting).
             `nav-island` is the load entrance (globals.css): the pill grows
             out of a small capsule into this box. --pill-h mirrors the
             resting height for its overshoot frames; shrink-0, or the band's
             flex row squeezes the sideways overshoot back to 100%. */
          className={cn(
            /* The design's « big white pill behind the nav »: a solid-white
               rounded bar floating with even gaps on every side (the sticky band's
               gutters + top padding give the spaces; the content below uses the
               same gutters, so the pill aligns with the page). */
            "nav-island pointer-events-auto relative flex w-full shrink-0 flex-col overflow-hidden rounded-[32px] border border-[#efe9e3] bg-white text-foreground backdrop-blur-xl transition-[height,box-shadow,opacity,translate,visibility] duration-[520ms] ease-soft",
            scrolled ? "[--pill-h:3.5rem]" : "[--pill-h:3.5rem] md:[--pill-h:4rem]",
            hiddenByProductBar
              ? "invisible -translate-y-2 opacity-0"
              : "visible translate-y-0 opacity-100",
            inlineSearch && searchFieldFocus,
            pillState,
          )}
        >
          {/* Nav row: the pill's content box (its height minus the 2px of
              border), so everything in it is optically centred. The bloc grows
              beneath it when the menu or the search opens. */}
          <div
            ref={navRowRef}
            className={cn(
              "nav-island-content flex w-full shrink-0 items-center transition-[height] duration-[420ms] ease-soft",
              scrolled ? "h-[54px]" : "h-[54px] md:h-[62px]",
            )}
          >
            {/* Mobile row: menu | logo | search + panier */}
            {/* A three-track grid so the logo is centred on the BAR, not centred
                between the buttons: mx-auto put it off-centre because there is
                one control on the left and two on the right. px-[5px] + the 1px
                hairline puts the 44px buttons 6px inside the 56px pill on every
                side, as they already sit vertically (the capsuleBar geometry). */}
            <div className="grid w-full grid-cols-[1fr_auto_1fr] items-center px-[5px] md:hidden">
              <button
                ref={menuBtnRef}
                type="button"
                className={cn(iconBtn.base, iconBtn.ghost, "justify-self-start")}
                aria-label={mobileOpen ? "Fermer le menu" : "Menu"}
                aria-expanded={mobileOpen}
                aria-controls={mobileOpen ? "mobile-menu" : undefined}
                onClick={() => {
                  /* Place the sheet before it renders, so its island grows
                     from the right spot (see the islandGrow layout effect). */
                  const r = mobileOpen ? null : blocRef.current?.getBoundingClientRect();
                  if (r) setDropTop(Math.round(r.bottom + 12));
                  setMobileOpen((v) => !v);
                }}
              >
                {mobileOpen ? (
                  <X aria-hidden className="size-5" />
                ) : (
                  <Menu aria-hidden className="size-5" />
                )}
              </button>

              <Link
                href="/"
                className="grid min-h-11 min-w-11 shrink-0 place-items-center justify-self-center rounded-full"
              >
                <img
                  src={logoSrc}
                  alt={logoAlt}
                  width={300}
                  height={300}
                  className="h-9 w-auto object-contain"
                />
              </Link>

              <div className="flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={(e) =>
                    openSearchOverlay({ x: e.clientX, y: e.clientY }, e.currentTarget)
                  }
                  aria-label="Rechercher"
                  className={cn(iconBtn.base, iconBtn.ghost)}
                >
                  <Search aria-hidden className="size-5" />
                </button>

                <Link
                  href="/panier"
                  aria-label="Panier"
                  aria-current={current("/panier")}
                  className={cn(iconBtn.base, iconBtn.ghost, "relative", currentTint)}
                >
                  <ShoppingBag aria-hidden className="size-5" />
                  {cartCount > 0 && (
                    <span className={cn(countBadge, "absolute top-0.5 right-0.5")}>
                      {cartCount}
                    </span>
                  )}
                </Link>
              </div>
            </div>

            {/* Desktop: the whole bar turns into a search field when search is
                open. Same px-4/lg:px-5 as the nav, so the magnifier sits on the
                logo line and the close button on the Panier slot. */}
            {inlineSearch ? (
              <form
                role="search"
                onSubmit={submitSearch}
                className="hidden w-full items-center gap-3 px-4 md:flex lg:px-5"
              >
                <Search aria-hidden className="size-5 shrink-0 text-muted-foreground" />
                <input
                  ref={inlineInputRef}
                  type="search"
                  enterKeyHint="search"
                  autoComplete="off"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Rechercher un produit, une marque, un univers…"
                  aria-label="Rechercher un produit"
                  /* The pill carries the focus indicator (searchFieldFocus).
                     16px on touch: a landscape phone gets this md+ pill, and
                     iOS zooms the page into any field under 16px. */
                  className="h-11 min-w-0 flex-1 bg-transparent text-base placeholder:text-muted-foreground focus-visible:outline-none pointer-fine:text-[15px] [&::-webkit-search-cancel-button]:appearance-none"
                />
                <button
                  type="button"
                  onClick={() => closeInlineSearch(true)}
                  aria-label="Fermer la recherche"
                  className={cn(iconBtn.base, iconBtn.ghost)}
                >
                  <X aria-hidden className="size-5" />
                </button>
              </form>
            ) : (
              /* Three tracks, like the mobile row: the shortcuts are centred on
                 the PILL whatever the two side groups measure. */
              <nav
                aria-label="Navigation principale"
                className="hidden w-full grid-cols-[1fr_auto_1fr] items-center gap-3 px-4 md:grid lg:px-5"
              >
                {/* Left: logo + Catégories read as one group; a 20–24px gap
                    keeps them related but not cramped. */}
                <div className="flex min-w-0 items-center gap-5 justify-self-start lg:gap-6">
                  <Link href="/" className="hit-44 shrink-0 rounded-full" {...dwellClose}>
                    <img
                      src={logoSrc}
                      alt={logoAlt}
                      width={300}
                      height={300}
                      className={cn(
                        "w-auto object-contain transition-[height] duration-[420ms] ease-soft",
                        scrolled ? "h-9" : "h-10 lg:h-11",
                      )}
                    />
                  </Link>

                  <div
                    className="relative shrink-0"
                    onPointerEnter={onTriggerPointerEnter}
                    onPointerLeave={onTriggerPointerLeave}
                  >
                    <button
                      ref={megaTriggerRef}
                      type="button"
                      aria-label="Catégories"
                      aria-expanded={megaOpen}
                      aria-controls="mega-panel"
                      onFocus={warmUp}
                      onKeyDown={onTriggerKeyDown}
                      onClick={toggleMega}
                      className={cn(
                        "inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-[13px] font-semibold transition-colors duration-200 pointer-coarse:h-11",
                        megaOpen
                          ? "bg-primary text-primary-foreground"
                          : "bg-primary/10 text-primary-ink hover:bg-primary/15",
                      )}
                    >
                      <LayoutGrid aria-hidden className="size-4" />
                      {/* Labelled on tablets, where the pill has room and no
                          shortcuts; icon-only at lg, where the shortcuts need
                          the width; labelled again from xl. */}
                      <span className="hidden md:inline lg:hidden xl:inline">Catégories</span>
                      <ChevronDown
                        aria-hidden
                        className={cn(
                          "size-3.5 transition-transform duration-300 ease-soft",
                          megaOpen && "rotate-180",
                        )}
                      />
                    </button>
                  </div>
                </div>

                {/* Centre: raccourcis. 8px apart on touch, where they are 44px. */}
                <ul
                  className="col-start-2 hidden items-center gap-0.5 pointer-coarse:gap-2 lg:flex"
                  {...dwellClose}
                >
                  {navShortcuts.map((s) => {
                    const Icon = s.icon;
                    return (
                      <li key={s.label} className={s.show}>
                        {/* h-8: the Catégories chip's box (chip.sm), not the
                            31.5px that py-1.5 gave the 13px line. */}
                        <Link
                          href={s.href}
                          aria-current={current(s.href)}
                          className={cn(
                            "flex h-8 items-center gap-1.5 rounded-full px-3 text-[13px] font-medium whitespace-nowrap transition-colors duration-200 pointer-coarse:h-11",
                            s.accent
                              ? "text-primary hover:bg-primary/10 hover:text-primary-ink"
                              : "text-graphite hover:bg-secondary hover:text-primary",
                            currentTint,
                          )}
                        >
                          {Icon && <Icon aria-hidden className="size-4" />}
                          {s.label}
                        </Link>
                      </li>
                    );
                  })}
                </ul>

                {/* Right: actions (8px apart on touch, like the phone row). */}
                <div
                  className="col-start-3 flex items-center gap-1 justify-self-end pointer-coarse:gap-2"
                  {...dwellClose}
                >
                  <button
                    ref={searchTriggerRef}
                    type="button"
                    onClick={openInlineSearch}
                    aria-label="Rechercher"
                    className={cn(iconBtn.base, iconBtn.ghost)}
                  >
                    <Search aria-hidden className="size-5" />
                  </button>
                  <Link
                    href="/reels"
                    aria-label="Reels Tokyo"
                    aria-current={current("/reels")}
                    className={cn(iconBtn.base, iconBtn.ghost, currentTint)}
                  >
                    <Clapperboard aria-hidden className="size-5" />
                  </Link>
                  <Link
                    href="/account"
                    aria-label="Mon compte"
                    aria-current={current("/account")}
                    className={cn(iconBtn.base, iconBtn.ghost, currentTint)}
                  >
                    <User aria-hidden className="size-5" />
                  </Link>
                  <Link
                    href="/favoris"
                    aria-label="Favoris"
                    aria-current={current("/favoris")}
                    className={cn(iconBtn.base, iconBtn.ghost, "relative", currentTint)}
                  >
                    <Heart aria-hidden className="size-5" />
                    {favCount > 0 && (
                      <span className={cn(countBadge, "absolute top-0.5 right-0.5")}>
                        {favCount}
                      </span>
                    )}
                  </Link>
                  <Link
                    href="/panier"
                    aria-label="Panier"
                    aria-current={current("/panier")}
                    className={cn(iconBtn.base, iconBtn.ghost, "relative", currentTint)}
                  >
                    <ShoppingBag aria-hidden className="size-5" />
                    {cartCount > 0 && (
                      <span className={cn(countBadge, "absolute top-0.5 right-0.5")}>
                        {cartCount}
                      </span>
                    )}
                  </Link>
                </div>
              </nav>
            )}
          </div>

          {/* Inline search suggestions / results, under a hairline inside the
              same bloc. Inset so chips and thumbnails land on the logo line
              (45px at md, 49px at lg). */}
          {inlineSearch && (
            <div className="hidden max-h-[min(60dvh,420px)] overflow-y-auto overscroll-contain border-t border-border/70 p-2 md:block">
              <ResultCount hasQuery={hasQuery} count={results.length} />
              {hasQuery && (
                <>
                  <SearchResults
                    results={results}
                    onPick={() => closeInlineSearch(false)}
                    columns
                    rowClassName="lg:px-3"
                  />
                  <Link
                    href={`/recherche?q=${encodeURIComponent(searchQuery.trim())}`}
                    onClick={() => closeInlineSearch(false)}
                    className="mt-1 flex h-12 items-center justify-between gap-3 rounded-2xl bg-foreground px-4 text-left text-[13px] font-semibold text-background transition-[filter] hover:brightness-125"
                  >
                    <span className="min-w-0 truncate">
                      Voir tous les résultats pour «&nbsp;{searchQuery.trim()}&nbsp;»
                    </span>
                    <span className="grid size-8 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground">
                      <ArrowRight aria-hidden className="size-4" strokeWidth={2.4} />
                    </span>
                  </Link>
                </>
              )}
              {/* Also under "no match", so a dead-end query still offers a way on. */}
              {(!hasQuery || results.length === 0) && (
                <TrendingSuggestions
                  onPick={(s, e) => pickSuggestion(s, e, inlineInputRef)}
                  className={cn("px-2 pb-2 lg:px-3", hasQuery ? "pt-3" : "pt-2")}
                />
              )}
            </div>
          )}

          {/* Expanded menu: part of the SAME bloc as the nav row, split by a
              hairline separator (like the product-switcher reference). The bloc
              grows to fit it, so the bar and menu read as one element. Inert
              while closed, so none of it is in the tab order. */}
          <div
            id="mega-panel"
            aria-hidden={!megaOpen}
            inert={!megaOpen}
            onPointerEnter={onPanelPointerEnter}
            className={cn(
              "min-h-0 flex-1 border-t border-border/70 transition-[opacity,translate] duration-300 ease-soft",
              inlineSearch ? "hidden" : "hidden md:flex",
              megaOpen
                ? "translate-y-0 opacity-100 delay-100"
                : "pointer-events-none translate-y-2 opacity-0",
            )}
          >
            <div className="flex min-h-0 w-full flex-1">
              {/* Universe rail: a vertical tablist. The icon tile lands on the
                  logo line (45px at md, 49px at lg). Both columns scroll
                  internally when the viewport is too short for them. */}
              <div
                ref={railRef}
                className="no-scrollbar w-52 shrink-0 overflow-y-auto overscroll-contain border-r border-border/70 bg-surface-warm/60 px-2 py-2.5 lg:w-64"
              >
                <div ref={railInnerRef}>
                  <p className="eyebrow px-2 pb-1 text-muted-foreground lg:px-3">Nos univers</p>
                  <ul
                    role="tablist"
                    aria-orientation="vertical"
                    aria-label="Nos univers"
                    onKeyDown={onRailKeyDown}
                    /* 8px apart on touch, where the tabs are 44px (like the pill's own targets). */
                    className="space-y-0.5 pointer-coarse:space-y-2"
                  >
                    {megaMenu.map((cat, idx) => {
                      const Icon = cat.icon;
                      const active = idx === activeMega;
                      return (
                        <li key={cat.key} role="none">
                          <button
                            ref={(el) => {
                              railTabRefs.current[idx] = el;
                            }}
                            type="button"
                            role="tab"
                            id={`mega-tab-${idx}`}
                            aria-selected={active}
                            aria-controls="mega-content"
                            tabIndex={active ? 0 : -1}
                            onClick={() => setActiveMega(idx)}
                            onPointerEnter={(e) => onTabPointerEnter(e, idx)}
                            onPointerLeave={onTabPointerLeave}
                            className={cn(
                              "flex w-full items-center gap-2.5 rounded-full px-2 py-1.5 text-left text-[13px] font-medium transition-colors duration-200 pointer-coarse:py-2 lg:px-3",
                              // Selected capsule = solid crimson + gloss, like every tab.
                              active
                                ? "pill-gloss bg-primary text-primary-foreground"
                                : "text-foreground hover:bg-secondary",
                            )}
                          >
                            <span
                              className={cn(
                                "grid size-7 shrink-0 place-items-center rounded-full transition-colors duration-200",
                                active ? "bg-primary-foreground/20" : "bg-surface",
                              )}
                            >
                              <Icon aria-hidden className="size-4" />
                            </span>
                            <span className="min-w-0 flex-1 truncate">{cat.label}</span>
                            <ArrowRight
                              aria-hidden
                              className={cn(
                                "size-3.5 shrink-0 transition-[opacity,translate] duration-200",
                                active ? "translate-x-0 opacity-100" : "-translate-x-1 opacity-0",
                              )}
                            />
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              </div>

              {/* Content. Its scrollbar stays visible (thin): when a short
                  viewport caps the panel, it is the only sign there is more. */}
              <div
                ref={menuContentRef}
                id="mega-content"
                role="tabpanel"
                aria-labelledby={`mega-tab-${activeMega}`}
                /* A tab the pointer only crossed on its way here never takes over. */
                onPointerEnter={onTabPointerLeave}
                className="flex min-w-0 flex-1 flex-col overflow-y-auto overscroll-contain p-5 [scrollbar-width:thin] lg:p-6"
              >
                {/* Unstretched wrapper: its height is what the panel measures. */}
                <div ref={menuInnerRef} className="shrink-0">
                  <div className="flex items-start justify-between gap-6">
                    <div className="min-w-0">
                      <p className="title-block truncate text-foreground">{activeUniverse?.label}</p>
                      {/* Every blurb stacked in one cell, like the sections
                          below: a blurb that wraps at tablet widths would
                          otherwise resize the panel as you switch universes. */}
                      <div className="mt-0.5 grid">
                        {megaMenu.map((universe, uIdx) => (
                          <p
                            key={universe.key}
                            aria-hidden={uIdx !== activeMega}
                            className={cn(
                              "col-start-1 row-start-1 text-[13px] text-muted-foreground",
                              uIdx !== activeMega && "invisible",
                            )}
                          >
                            {universe.blurb}
                          </p>
                        ))}
                      </div>
                    </div>
                    {/* The site's view-all link (tint chip), kept at its original
                        36px at a desk inside the menu (the pill's desktop look is
                        the reference) and 44px on touch, like the 26px/44px
                        chips around it. Section headings use the 44px default. */}
                    <ViewAllLink
                      href={activeUniverse?.href ?? "/"}
                      className="md:pointer-fine:h-9"
                    >
                      Voir tout<span className="sr-only"> {activeUniverse?.label}</span>
                    </ViewAllLink>
                  </div>

                  {/* Sections flow into balanced COLUMNS (CSS multi-column).
                      EVERY universe is rendered here, stacked into a single
                      grid cell with only the active one visible. The cell is
                      therefore as tall as the TALLEST universe, which is what
                      keeps the panel from resizing as you move between them,
                      and what the bloc's height is measured from. */}
                  <div className="mt-4 grid">
                    {megaMenu.map((universe, uIdx) => (
                      <div
                        key={universe.key}
                        aria-hidden={uIdx !== activeMega}
                        className={cn(
                          "col-start-1 row-start-1 columns-2 gap-4 transition-opacity duration-200 lg:columns-3 xl:columns-4",
                          uIdx === activeMega
                            ? "opacity-100"
                            : "pointer-events-none invisible opacity-0",
                        )}
                      >
                        {universe.sections.map((section, sIdx) => {
                          const href = section.href;
                          /* The eyebrow's 11px step, tracked 0.1em: at 12px /
                             0.14em the longest titles ("Accessoires et
                             Périphériques", 241px) wrapped in the 207–221px
                             columns at 768–1280 and dropped their column's
                             chips a line below the others. On touch the title
                             is a 44 × 44 target too (short ones like "Apple"
                             were 39px wide), and keeps 8px to its chips. */
                          const titleCls =
                            "eyebrow mb-1.5 text-primary-ink md:text-[11px] md:tracking-widest pointer-coarse:mb-2 pointer-coarse:flex pointer-coarse:min-h-11 pointer-coarse:min-w-11 pointer-coarse:items-center";
                          return (
                            /* break-inside-avoid keeps a section whole: without
                               it a list flowed across the column break and its
                               items landed under the next column with no title
                               above them. */
                            <div key={sIdx} className="mb-4 break-inside-avoid">
                              {section.title ? (
                                href ? (
                                  /* A block like the plain-text <p>: inline-block
                                     sat on a 24px strut and misaligned the
                                     column tops by 6px. -mx-1 px-1 + capsule:
                                     the focus ring rounds like every other
                                     control in the pill, the text stays put. */
                                  <Link
                                    href={href}
                                    className={cn(
                                      titleCls,
                                      "-mx-1 block w-fit rounded-full px-1 underline-offset-4 hover:underline",
                                    )}
                                  >
                                    {section.title}
                                  </Link>
                                ) : (
                                  <p className={titleCls}>{section.title}</p>
                                )
                              ) : universe.sections.some((s) => s.title) ? (
                                /* An untitled section beside titled ones (PC &
                                   Gaming's packs and PC keys, untitled in the
                                   store's taxonomy) keeps an empty title row,
                                   so its chips start on the same line as the
                                   next column's, not 20px (50 on touch) above. */
                                <p aria-hidden className={cn(titleCls, "invisible")}>
                                  &nbsp;
                                </p>
                              ) : null}
                              {/* On touch the 44px chips wrap side by side
                                  (8px apart) instead of one per line: stacked,
                                  Gift Cards' seven set a 942px panel at 768
                                  that every universe shared. */}
                              <div className="flex flex-col items-start gap-1 pointer-coarse:flex-row pointer-coarse:flex-wrap pointer-coarse:gap-2">
                                {section.items.map((item) => (
                                  <Link
                                    key={item.href}
                                    href={item.href}
                                    {...(item.newTab ? { target: "_blank", rel: "noopener noreferrer" } : {})}
                                    className={megaChip}
                                  >
                                    {item.label}
                                  </Link>
                                ))}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    ))}
                  </div>
                </div>

                {/* Product preview: a row along the bottom of the panel, under
                    a hairline separator. Horizontal mini-cards (pack shot
                    beside name and price) so everything is legible without
                    hover while the row stays short. The row never wraps: it
                    shows 2, 4 then 5 cards and drops the rest.
                    Outside the measured wrapper, with mt-auto: when the panel
                    is taller than its columns (the banner at 1920, or a
                    taller rail) the spare height opens up ABOVE the row, which
                    stays anchored to the panel's bottom edge. Always mounted
                    so the measure effect keeps observing it. */}
                <div
                  ref={previewRef}
                  className={cn(
                    "mt-auto shrink-0 pt-5",
                    (!previewFits || previewProducts.length === 0) && "hidden",
                  )}
                >
                  <div className="border-t border-border/70 pt-3">
                    <p className="eyebrow mb-2 text-muted-foreground">Produits populaires</p>
                    <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4 xl:grid-cols-5">
                      {previewProducts.slice(0, 5).map((p, i) => {
                        const strike = productStrike(p);
                        return (
                          <Link
                            key={p.slug}
                            href={`/${p.slug}`}
                            className={cn(
                              "group flex items-center gap-2.5 rounded-card border border-border bg-background p-2 transition-colors duration-200 hover:border-primary/40 hover:bg-primary/5",
                              i >= 2 && i < 4 && "hidden lg:flex",
                              i === 4 && "hidden xl:flex",
                            )}
                          >
                            {/* 24 − 8px inset = 16: concentric with the card. */}
                            <div className="size-14 shrink-0 overflow-hidden rounded-inner bg-product-media">
                              {p.image && (
                                <img
                                  src={p.image}
                                  srcSet={thumbSrcSet(p.image)}
                                  sizes="56px"
                                  alt=""
                                  width={56}
                                  height={56}
                                  loading={megaWarm ? "eager" : "lazy"}
                                  decoding="async"
                                  className="h-full w-full object-contain p-1"
                                />
                              )}
                            </div>
                            {/* @container: the struck price only shows when
                                  the text column can hold it on the same line. */}
                            <div className="@container min-w-0 flex-1">
                              <p className="line-clamp-2 text-[12px] leading-tight font-medium text-foreground">
                                {p.title}
                              </p>
                              <div className="mt-1 flex items-baseline gap-1.5 whitespace-nowrap">
                                <span className="text-[12px] font-bold text-primary tabular-nums">
                                  {fmtPrice(p.price)} TND
                                </span>
                                {strike && (
                                  <span className="hidden text-[12px] text-muted-foreground tabular-nums line-through @[7.5rem]:inline">
                                    {fmtPrice(strike.strike)}
                                  </span>
                                )}
                              </div>
                            </div>
                          </Link>
                        );
                      })}
                    </div>
                  </div>
                </div>
              </div>

              {/* Featured banner — the builder's image block for a universe, as
                  the classic right-hand panel. Desktop only; stacked across
                  universes (overlaid in one cell) so switching never reflows the
                  content width. Shown only when SOME universe has a banner; it
                  self-stretches to the measured panel height (object-cover), so a
                  tall format never blows the layout. */}
              {anyBanner && (
                <div className="hidden shrink-0 self-stretch border-l border-border/70 lg:block">
                  <div className="grid h-full">
                    {megaMenu.map((u, uIdx) =>
                      u.banner ? (
                        <Link
                          key={u.key}
                          href={u.banner.href && u.banner.href !== "#" ? u.banner.href : u.href}
                          aria-hidden={uIdx !== activeMega}
                          tabIndex={uIdx === activeMega ? undefined : -1}
                          className={cn(
                            "group relative col-start-1 row-start-1 block h-full overflow-hidden transition-opacity duration-200",
                            NAV_BANNER_WIDTH[u.banner.size] ?? NAV_BANNER_WIDTH.md,
                            uIdx === activeMega
                              ? "opacity-100"
                              : "pointer-events-none invisible opacity-0",
                          )}
                        >
                          <img
                            src={u.banner.imageUrl}
                            alt={u.banner.alt}
                            loading={megaWarm ? "eager" : "lazy"}
                            decoding="async"
                            className="h-full w-full object-cover transition-transform duration-700 group-hover:scale-105"
                          />
                          <div className="absolute inset-0 bg-gradient-to-t from-foreground/75 via-foreground/15 to-transparent" />
                          {(u.banner.eyebrow || u.banner.title) && (
                            <div className="absolute inset-x-0 bottom-0 p-4">
                              {u.banner.eyebrow && (
                                <p className="eyebrow mb-1 text-primary-foreground/70">
                                  {u.banner.eyebrow}
                                </p>
                              )}
                              {u.banner.title && (
                                <p className="title-block text-primary-foreground">{u.banner.title}</p>
                              )}
                            </div>
                          )}
                        </Link>
                      ) : null,
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </header>

      {/* ---------------------------------------------------------------
          Mobile menu: a dropdown that falls from the nav pill rather than a
          panel sliding in from the screen edge, so it reads as part of the
          same bloc the desktop mega menu grows out of. Its top is measured
          from the pill; its sides are the pill's edges.
          --------------------------------------------------------------- */}
      {mobileOpen &&
        typeof document !== "undefined" &&
        createPortal(
          <div className="md:hidden">
            <div
              aria-hidden
              className="fixed inset-0 z-[90] animate-in bg-foreground/40 backdrop-blur-sm duration-300 fade-in"
              onClick={() => setMobileOpen(false)}
            />
            {/* A disclosure, not a modal dialog: its close control is the
                pill's own X (aria-expanded, aria-controls), which sits outside
                it, so aria-modal hid the only way to close it from screen
                readers. The page behind is still inert, so Tab and the
                virtual cursor cycle between the pill and the menu only. */}
            <nav
              ref={menuDialogRef}
              id="mobile-menu"
              aria-label="Menu"
              style={{
                top: dropTop,
                maxHeight: `calc(100dvh - ${dropTop}px - 12px - env(safe-area-inset-bottom))`,
              }}
              /* No enter classes: it grows out of an island on open
                 (islandGrow, run from a layout effect before first paint). */
              className="fixed left-(--gutter-l) right-(--gutter-r) z-[95] flex flex-col overflow-hidden rounded-island border border-border bg-background/98 shadow-overlay backdrop-blur-xl"
            >
              <div className="nav-island-sheet-content overflow-y-auto overscroll-contain">
                {/* Shortcuts first (the same links the pill shows on desktop),
                    as one scrollable row of 44px chips on the sheet's 16px edge.
                    As in the pill, "Bons plans" is accented by its crimson
                    label, not a tint: the tint means "you are here", so only
                    the current page's chip carries it. */}
                <div className="no-scrollbar flex snap-x scroll-px-4 gap-2 overflow-x-auto px-4 py-3">
                  {navShortcuts.map((s) => {
                    const Icon = s.icon;
                    return (
                      <Link
                        key={s.label}
                        href={s.href}
                        aria-current={current(s.href)}
                        onClick={() => setMobileOpen(false)}
                        className={cn(
                          chip.base,
                          chip.lg,
                          chip.neutral,
                          "snap-start font-semibold aria-[current=page]:border-transparent",
                          s.accent && "text-primary-ink",
                          currentTint,
                        )}
                      >
                        {Icon && <Icon aria-hidden className="size-4" />}
                        {s.label}
                      </Link>
                    );
                  })}
                </div>

                {/* The accordion prints its own "Rayons" heading. */}
                <div className="border-t border-border/70">
                  <MobileCategoryAccordion
                    categories={mobileCategories}
                    onClose={() => setMobileOpen(false)}
                  />
                </div>

                <div className="border-t border-border/70 p-4">
                  <p className="eyebrow text-muted-foreground">Service client</p>
                  {/* -mx-3: the row capsules bleed so their text sits on the
                      eyebrow's 16px edge. */}
                  <ul className="-mx-3 mt-1.5">
                    {serviceLinks.map((l) => {
                      const cls =
                        "flex min-h-11 items-center rounded-full px-3 text-[14px] text-graphite transition-colors duration-200 active:bg-secondary";
                      return (
                        <li key={l.label}>
                          {l.href.startsWith("/") ? (
                            <Link
                              href={l.href}
                              onClick={() => setMobileOpen(false)}
                              className={cls}
                            >
                              {l.label}
                            </Link>
                          ) : (
                            <a href={l.href === "tel:" ? telHref(sitePhone) : l.href} className={cls}>
                              {l.label}
                            </a>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                  <a
                    href={telHref(sitePhone)}
                    className="mt-2 flex h-12 items-center gap-2.5 rounded-full bg-secondary pr-4 pl-2 text-[13px] font-semibold text-graphite tabular-nums"
                  >
                    {/* 32px disc 8px inside a 48px capsule: concentric. */}
                    <span className="grid size-8 shrink-0 place-items-center rounded-full bg-primary/10">
                      <Phone aria-hidden className="size-4 text-primary" />
                    </span>
                    {sitePhone}
                  </a>
                </div>
              </div>
            </nav>
          </div>,
          document.body,
        )}

      {/* Mobile search: a dialog on the beige canvas whose bar is the nav pill
          itself, in place (same gutter, same top gap, same 56px capsule),
          with suggestions or live results in an island 12px beneath it. */}
      {searchOpen &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Recherche"
            className={cn(
              "fixed inset-0 z-[110] flex flex-col bg-surface-beige pb-[env(safe-area-inset-bottom)]",
              searchOrigin ? "tokyo-search-reveal" : "animate-in duration-200 fade-in",
            )}
            style={revealStyle}
          >
            {/* The pill's own top gap (24px, 12px once scrolled), so the bar
                lands exactly on the pill it replaces during the reveal. */}
            <div
              className={cn(
                "gutter-x tokyo-search-content shrink-0",
                scrolled
                  ? "pt-[calc(0.75rem+env(safe-area-inset-top))]"
                  : "pt-[calc(1.5rem+env(safe-area-inset-top))]",
              )}
            >
              <form
                role="search"
                onSubmit={submitSearch}
                className={cn(capsuleBar, "shadow-float", searchFieldFocus)}
              >
                <button
                  type="button"
                  onClick={closeSearchOverlay}
                  aria-label="Retour"
                  className={cn(iconBtn.base, iconBtn.ghost)}
                >
                  <ArrowLeft aria-hidden className="size-5" />
                </button>
                <div className="relative h-11 min-w-0 flex-1">
                  <input
                    ref={searchInputRef}
                    type="search"
                    enterKeyHint="search"
                    inputMode="search"
                    autoComplete="off"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    aria-label="Rechercher un produit"
                    placeholder=" "
                    /* The bar carries the focus indicator (searchFieldFocus);
                       the real caret hides behind the animated one while empty. */
                    className={cn(
                      "absolute inset-0 w-full bg-transparent text-base focus-visible:outline-none [&::-webkit-search-cancel-button]:appearance-none",
                      !searchQuery && "caret-transparent",
                    )}
                  />
                  {!searchQuery && (
                    <span
                      aria-hidden
                      className="pointer-events-none absolute inset-0 flex items-center overflow-hidden text-base whitespace-nowrap text-muted-foreground"
                    >
                      Rechercher «&nbsp;
                      <span className="text-foreground">{typed}</span>
                      <span className="ml-0.5 inline-block h-4 w-px animate-pulse bg-foreground/60" />
                      &nbsp;»
                    </span>
                  )}
                </div>
                {searchQuery && (
                  <button
                    type="button"
                    onClick={() => {
                      setSearchQuery("");
                      searchInputRef.current?.focus();
                    }}
                    aria-label="Effacer"
                    className={cn(iconBtn.base, iconBtn.ghost, "text-muted-foreground")}
                  >
                    <X aria-hidden className="size-5" />
                  </button>
                )}
              </form>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
              <div className="gutter-x pt-3 pb-6">
                <div className="rounded-island border border-border bg-background p-4 shadow-island">
                  <ResultCount hasQuery={hasQuery} count={results.length} />
                  {hasQuery ? (
                    <>
                      <SearchResults
                        results={results}
                        onPick={closeSearchOverlay}
                        className="-mx-2"
                      />
                      {/* No match: the suggestions stay, so it is not a dead end. */}
                      {results.length === 0 && (
                        <TrendingSuggestions
                          sheet
                          onPick={(s, e) => pickSuggestion(s, e, searchInputRef)}
                          className="mt-3"
                        />
                      )}
                      <Link
                        href={`/recherche?q=${encodeURIComponent(searchQuery.trim())}`}
                        onClick={closeSearchOverlay}
                        className="mt-3 flex h-12 items-center justify-between gap-3 rounded-2xl bg-foreground px-4 text-left text-[13px] font-semibold text-background"
                      >
                        <span className="min-w-0 truncate">
                          Voir tous les résultats pour «&nbsp;{searchQuery.trim()}&nbsp;»
                        </span>
                        <span className="grid size-8 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground">
                          <ArrowRight aria-hidden className="size-4" strokeWidth={2.4} />
                        </span>
                      </Link>
                    </>
                  ) : (
                    <>
                      <TrendingSuggestions
                        sheet
                        onPick={(s, e) => pickSuggestion(s, e, searchInputRef)}
                      />

                      <p className="eyebrow mt-6 flex items-center gap-1.5 text-muted-foreground">
                        <Clock aria-hidden className="size-3.5" /> Recherches populaires
                      </p>
                      {/* The result rows' language (rounded-card, hover fill,
                          bled to the island's 8px inset), so focus draws a
                          rounded ring like theirs, not a sharp rectangle. */}
                      <ul className="-mx-2 mt-1">
                        {popularSearches.map((s) => (
                          <li key={s}>
                            <button
                              type="button"
                              onClick={(e) => pickSuggestion(s, e, searchInputRef)}
                              className="flex min-h-11 w-full items-center gap-3 rounded-card px-2 py-1.5 text-left text-[14px] text-graphite transition-colors duration-200 hover:bg-secondary hover:text-primary"
                            >
                              <Search aria-hidden className="size-4 text-muted-foreground" />
                              <span className="flex-1">{s}</span>
                              <ArrowRight aria-hidden className="size-4 text-muted-foreground" />
                            </button>
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                </div>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}

/**
 * The results' screen-reader announcement. It stays mounted (empty) from the
 * moment the search opens: a live region inserted together with its text is
 * not announced, so the first count went unheard.
 */
function ResultCount({ hasQuery, count }: { hasQuery: boolean; count: number }) {
  return (
    <p className="sr-only" aria-live="polite">
      {!hasQuery
        ? ""
        : count === 0
          ? "Aucun produit ne correspond."
          : `${count} produit${count > 1 ? "s" : ""}`}
    </p>
  );
}

/**
 * "Tendances": chips that fill the search field. The phone overlay (`sheet`)
 * uses the 44px sheet chip. The desktop dropdown uses the 32px inline chip
 * with a 44px hit area (rows 12px apart), and on touch tablets the same 44px
 * chip 8px apart as the overlay: 32px chips whose hit areas touched there.
 */
function TrendingSuggestions({
  onPick,
  sheet = false,
  className,
}: {
  onPick: (suggestion: string, e: ReactMouseEvent) => void;
  sheet?: boolean;
  className?: string;
}) {
  return (
    <div className={className}>
      <p className="eyebrow flex items-center gap-1.5 text-muted-foreground">
        <TrendingUp aria-hidden className="size-3.5" /> Tendances
      </p>
      <div className={cn("mt-3 flex flex-wrap gap-2", !sheet && "gap-y-3 pointer-coarse:gap-y-2")}>
        {searchSuggestions.map((s) => (
          <button
            key={s}
            type="button"
            onClick={(e) => onPick(s, e)}
            className={cn(
              chip.base,
              chip.neutral,
              sheet ? chip.lg : [chip.sm, "hit-44 pointer-coarse:h-11 pointer-coarse:px-4"],
            )}
          >
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Live search rows (desktop dropdown and mobile island share them). */
function SearchResults({
  results,
  onPick,
  columns = false,
  className,
  rowClassName,
}: {
  results: Product[];
  onPick: () => void;
  /**
   * Desktop dropdown: rows flow into 2 (lg) / 3 (2xl) columns. A single
   * full-width column put 1,700px between a title and its price at 1920.
   */
  columns?: boolean;
  /** On the wrapper (e.g. a negative margin so thumbnails sit on the island's edge). */
  className?: string;
  /** On each row and the empty line (the desktop inset steps with the logo line). */
  rowClassName?: string;
}) {
  return (
    <div className={className}>
      {results.length === 0 ? (
        <p aria-hidden className={cn("px-2 py-3 text-[13px] text-muted-foreground", rowClassName)}>
          Aucun produit ne correspond.
        </p>
      ) : (
        <ul className={cn(columns && "grid gap-1 lg:grid-cols-2 2xl:grid-cols-3")}>
          {results.map((p) => (
            <li key={p.slug} className="min-w-0">
              {/* rounded-card: 32px pill (or 28px island) minus the ~8px inset.
                  The 44px thumbnail sits 6–12px inside the row: rounded-inner. */}
              <Link
                href={`/${p.slug}`}
                onClick={onPick}
                className={cn(
                  "flex min-h-14 items-center gap-3 rounded-card px-2 transition-colors duration-200 hover:bg-secondary",
                  rowClassName,
                )}
              >
                <img
                  src={p.image}
                  srcSet={thumbSrcSet(p.image)}
                  sizes="44px"
                  alt=""
                  width={44}
                  height={44}
                  decoding="async"
                  className="size-11 shrink-0 rounded-inner bg-product-media object-contain p-1"
                />
                {/* Two lines on phones: one line cut the variants ("… SIM
                    Noir", "… SIM Argent") down to identical rows. Both fit the
                    56px row. */}
                <span className="line-clamp-2 min-w-0 flex-1 text-[14px] leading-snug font-medium text-foreground md:line-clamp-1">
                  {p.title}
                </span>
                <span className="ml-auto shrink-0 text-[13px] font-bold text-primary tabular-nums">
                  {fmtPrice(p.price)} TND
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
