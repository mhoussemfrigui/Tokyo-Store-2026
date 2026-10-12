import type { NavImageAspect, NavBlockSize } from "@/lib/cms/nav-composer-model";

/**
 * Client-safe DTOs for the crimson header, produced by the server mapper
 * (`getTokyoHeaderNav`, src/lib/api/tokyo-header-nav.ts) from the resolved nav
 * builder and consumed by `<Header>` as props. Plain/serializable — icons are
 * PROMO_ICON_MAP NAMES (the header resolves them to lucide components), prices are
 * numbers. No `server-only`, no DB, so both the server mapper and the client
 * header import this one contract.
 */

/** A chip link inside a universe section (a sub-category / curated link). */
export type NavMenuItem = { label: string; href: string; newTab?: boolean };
/** One titled column of chips in a universe panel. `href` → the title's shelf
 *  (null = plain-text heading). */
export type NavMenuSection = { title?: string; href: string | null; items: NavMenuItem[] };
/** A product in a universe's « Produits populaires » preview row. */
export type NavMenuProduct = {
  slug: string;
  title: string;
  image: string | null;
  price: number;
  oldPrice: number | null;
};
/** A universe's featured banner image (the builder's image block). */
export type NavMenuBanner = {
  imageUrl: string;
  imageMobileUrl: string | null;
  alt: string;
  eyebrow?: string;
  title?: string;
  href: string;
  aspect: NavImageAspect;
  size: NavBlockSize;
  showOnMobile: boolean;
};
/** A « Catégories » mega-menu universe (one rail tab + its panel). */
export type NavUniverse = {
  key: string;
  label: string;
  blurb: string;
  /** PROMO_ICON_MAP name — resolved to a lucide component in the header. */
  icon: string | null;
  /** « Voir tout » target. */
  href: string;
  sections: NavMenuSection[];
  products: NavMenuProduct[];
  banner: NavMenuBanner | null;
};
/** A centre quick-link pill. */
export type NavShortcut = { label: string; href: string; icon: string | null; accent: boolean };
/** A mobile « Service client » link. `href === "tel:"` → the backend contact
 *  phone, filled at render. */
export type NavServiceLink = { label: string; href: string };

/** The whole header nav, split by slot. */
export type TokyoHeaderNav = {
  universes: NavUniverse[];
  shortcuts: NavShortcut[];
  service: NavServiceLink[];
};

/** Empty header nav — the degraded shape when the resolver yields nothing. */
export const EMPTY_HEADER_NAV: TokyoHeaderNav = { universes: [], shortcuts: [], service: [] };
