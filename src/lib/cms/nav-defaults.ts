/**
 * The DEFAULT crimson header nav, as composable roots. ONE source of truth for
 * (a) the boot seed that materializes them into the `main` menu as editable
 * `nav_items`, and (b) the storefront resolver's fallback when the menu has not
 * been materialized yet. Reproduces the former hardcoded mega-menu exactly so a
 * fresh / un-seeded store is unchanged.
 *
 * Three SLOTS make up the header:
 *   - `mega`     — the « Catégories » universes (rail + panel). Each is a CATEGORY
 *                  link, so its `taxonomy` block auto-expands that universe's
 *                  sub-categories and its `products` block shows that universe's
 *                  own products (zero config, always in sync with the catalog).
 *   - `shortcut` — the centre quick-link pills (Bons plans, Nouveautés, …).
 *   - `service`  — the mobile menu's « Service client » links.
 *
 * Pure / client-safe (no DB). The universe sub-categories + preview products are
 * NOT baked here — they resolve live from the catalog at render, so the default
 * stays in sync without a re-seed.
 */
import type { NavDropdown, NavSlot } from "./nav-composer-model";

export type DefaultNavRoot = {
  /** Stable slug — the react key for the fallback + the seed marker. */
  slug: string;
  label: string;
  href: string;
  icon: string | null;
  /** Internal target (category universes) so the root is liveness-checked AND its
   *  taxonomy/products blocks inherit the category. Null for plain-URL roots. */
  kind: string | null;
  ref: string | null;
  slot: NavSlot;
  blurb?: string | null;
  accent?: boolean;
  dropdown: NavDropdown | null;
};

export type NavDefaultsOpts = {
  /** nav.*.name / sublink label overrides (blank → the fallback). */
  label: (key: string, fallback: string) => string;
};

/** The default universes — slug (= live category slug), label, icon (a
 *  PROMO_ICON_MAP name) and one-line blurb. Mirrors the former UNIVERSE_META. */
const UNIVERSES: { slug: string; label: string; icon: string; blurb: string }[] = [
  { slug: "univers-apple", label: "Univers Apple", icon: "Smartphone", blurb: "iPhone, iPad, Mac, Apple Watch et accessoires officiels." },
  { slug: "telephonie", label: "Téléphonie", icon: "Phone", blurb: "Smartphones, tablettes, téléphones et tous leurs accessoires." },
  { slug: "console-gaming", label: "Console Gaming", icon: "Gamepad2", blurb: "Consoles PlayStation et Nintendo, jeux et accessoires." },
  { slug: "pc-gaming", label: "PC Gaming", icon: "Laptop", blurb: "Écrans, claviers, souris, casques et jeux PC." },
  { slug: "audiovisuel", label: "Audiovisuel", icon: "Headphones", blurb: "Casques, écouteurs, enceintes, photo et éclairage." },
  { slug: "univers-tokyo-store", label: "Univers Tokyo Store", icon: "LayoutGrid", blurb: "Gadgets, figurines, tendances et nouveautés." },
  { slug: "objets-connectes", label: "Objets Connectés", icon: "Home", blurb: "Montres connectées, accessoires et maison intelligente." },
  { slug: "cartes-cadeaux-et-abonnements", label: "Cartes-cadeaux et Abonnements", icon: "Tv", blurb: "Cartes PlayStation, Xbox, Nintendo, Steam et abonnements." },
];

/** The default centre shortcut pills (slug = flat shelf, icon name, accent). */
const SHORTCUTS: { slug: string; label: string; icon: string | null; accent?: boolean }[] = [
  { slug: "bons-plans", label: "Bons plans", icon: "Flame", accent: true },
  { slug: "notre-selection", label: "Notre sélection", icon: null },
  { slug: "iphones-d-occasion", label: "iPhones d'occasion", icon: null },
  { slug: "nouveautes", label: "Nouveautés", icon: null },
  { slug: "console-gaming", label: "Gaming", icon: "Gamepad2" },
  { slug: "gift-cards", label: "Gift Cards", icon: null },
];

/** The default mobile « Service client » links. `tel:` is filled from the backend
 *  contact phone at render (the « Reprendre mon iPhone » call-to-call). */
const SERVICE_LINKS: { label: string; href: string }[] = [
  { label: "Suivre ma commande", href: "/suivi-de-commande" },
  { label: "Blog", href: "/blog" },
  { label: "Reprendre mon iPhone", href: "tel:" },
];

/** A universe dropdown: auto sub-category sections + the universe's own products
 *  preview. Both inherit the root's category (no explicit slug needed). */
function universeDropdown(): NavDropdown {
  return {
    mobileVisible: true,
    columns: [
      { blocks: [{ type: "taxonomy" }] },
      { blocks: [{ type: "products", source: "category", count: 4, size: "md" }] },
    ],
  };
}

export function defaultNavRoots(opts: NavDefaultsOpts): DefaultNavRoot[] {
  const lbl = opts.label;

  const universes: DefaultNavRoot[] = UNIVERSES.map((u) => ({
    slug: u.slug,
    label: lbl(`nav.${u.slug}.name`, u.label),
    href: `/${u.slug}`,
    icon: u.icon,
    kind: "category",
    ref: u.slug,
    slot: "mega",
    blurb: u.blurb,
    dropdown: universeDropdown(),
  }));

  const shortcuts: DefaultNavRoot[] = SHORTCUTS.map((s) => ({
    slug: `shortcut-${s.slug}`,
    label: lbl(`nav.shortcut.${s.slug}`, s.label),
    href: `/${s.slug}`,
    icon: s.icon,
    kind: null,
    ref: null,
    slot: "shortcut",
    accent: s.accent ?? false,
    dropdown: null,
  }));

  const service: DefaultNavRoot[] = SERVICE_LINKS.map((l, i) => ({
    slug: `service-${i}`,
    label: l.label,
    href: l.href,
    icon: null,
    kind: null,
    ref: null,
    slot: "service",
    dropdown: null,
  }));

  return [...universes, ...shortcuts, ...service];
}
