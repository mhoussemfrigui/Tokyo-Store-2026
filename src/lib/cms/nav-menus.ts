/**
 * The fixed-key SYSTEM navigation menus the storefront looks up by `key`:
 *   - `main` — the header nav row (CMS → Nav Menu);
 *   - the three footer link columns (CMS → Footer), rendered in this order;
 *   - `maison-explore` — the « Explorer la maison » index at the foot of the
 *     Maison & legal pages (CMS → Footer).
 *
 * Single source of truth for those keys + the footer columns' built-in titles,
 * shared by the storefront reader (`listFooterColumns`), the Footer admin (its
 * one-click "Créer les colonnes du footer") and the data clean (which keeps
 * these menus, emptying only their items). Pure / client-safe (no DB, no
 * server-only) so client panels can import it too.
 */
export const MAIN_NAV_MENU_KEY = "main";

export type FooterColumnDefaultItem = { label: string; href: string };

/**
 * The three footer link columns of the live (tokyo) storefront footer, in
 * render order, each with its built-in title AND its default links. The links
 * reproduce EXACTLY what the footer used to hardcode, so an unedited store (seeded
 * at boot / demo, or falling back when no menu row exists) renders pixel-identical
 * — while every link is now editable in CMS → Footer. The `footer-society`
 * (« Légal ») column also feeds the footer's always-visible bottom legal row, so
 * the two can never drift (they used to: the column had CGU, the bottom row didn't).
 */
export const FOOTER_COLUMN_DEFAULTS: readonly {
  key: string;
  title: string;
  items: readonly FooterColumnDefaultItem[];
}[] = [
  {
    key: "footer-shop",
    title: "Boutique",
    items: [
      { label: "iPhone neuf", href: "/iphones-neufs" },
      { label: "iPhone reconditionné", href: "/iphones-d-occasion" },
      { label: "Mac & iPad", href: "/ipad-et-mac" },
      { label: "Apple Watch", href: "/apple-watch" },
      { label: "AirPods", href: "/airpods" },
      { label: "Accessoires", href: "/accessoires-apple-officiels" },
    ],
  },
  {
    key: "footer-support",
    title: "Tokyo Store",
    items: [
      { label: "À propos", href: "/apropos" },
      { label: "Recrutement", href: "/recrutement" },
      { label: "Aide & contact", href: "/aide" },
      { label: "Livraison & retours", href: "/livraison" },
      { label: "Garantie & SAV", href: "/garantie" },
    ],
  },
  {
    key: "footer-society",
    title: "Légal",
    items: [
      { label: "Mentions légales", href: "/mentions" },
      { label: "CGV", href: "/cgv" },
      { label: "CGU", href: "/cgu" },
      { label: "Confidentialité", href: "/confidentialite" },
      { label: "Cookies", href: "/cookies" },
    ],
  },
] as const;

/** The « Légal » column key — also the source of the footer's bottom legal row. */
export const FOOTER_LEGAL_COLUMN_KEY = "footer-society";

export const FOOTER_COLUMNS: readonly { key: string; title: string }[] = FOOTER_COLUMN_DEFAULTS.map(
  (c) => ({ key: c.key, title: c.title }),
);

export type FooterColumnDef = (typeof FOOTER_COLUMNS)[number];

/**
 * « Explorer la maison » — the editorial index of the maison's info pages shown
 * at the foot of the Maison & legal content pages (LegalPageRenderer routes,
 * the system CMS pages served by /[slug], /help). Edited in CMS → Footer:
 *   - menu `description` → the eyebrow (« Informations utiles »);
 *   - menu `name`        → the heading (« Explorer la maison »);
 *   - each item's label + `description` (the hint under it) + link, in order.
 */
export const MAISON_EXPLORE_MENU_KEY = "maison-explore";

export type MaisonExploreDefaultItem = { label: string; hint: string; href: string };

/**
 * Built-in content of the `maison-explore` menu — seeded once at boot
 * (`ensureSystemNavMenus`) and the storefront fallback while the menu row is
 * missing / the DB is unreachable. Pure data (client-safe).
 */
export const MAISON_EXPLORE_DEFAULTS: {
  name: string;
  description: string;
  items: readonly MaisonExploreDefaultItem[];
} = {
  name: "Explorer la maison",
  description: "Informations utiles",
  items: [
    { label: "À propos", hint: "La maison Tokyo", href: "/apropos" },
    { label: "Recrutement", hint: "Rejoindre la maison", href: "/recrutement" },
    { label: "Aide & contact", hint: "Nous écrire", href: "/aide" },
    { label: "Livraison & retours", hint: "Délais et retours", href: "/livraison" },
    { label: "Garantie & SAV", hint: "Garanties et réparations", href: "/garantie" },
    { label: "Conditions de vente", hint: "CGV", href: "/cgv" },
    { label: "Confidentialité", hint: "Vos données", href: "/confidentialite" },
    { label: "Mentions légales", hint: "Informations légales", href: "/mentions" },
  ],
};

/** Every system menu key — never deleted by the navigation data clean. */
export const SYSTEM_NAV_MENU_KEYS: readonly string[] = [
  MAIN_NAV_MENU_KEY,
  ...FOOTER_COLUMNS.map((c) => c.key),
  MAISON_EXPLORE_MENU_KEY,
];

/**
 * Storefront heading of a footer column = its menu NAME (renamable from CMS →
 * Footer), falling back to the built-in title when blank. A leading admin-only
 * "Footer — " prefix is dropped: the demo seed and older installs name these
 * menus "Footer — Boutique" etc., and those rows must keep rendering
 * "Boutique" (the heading the storefront always showed).
 */
export function footerColumnTitle(name: string | null | undefined, fallback: string): string {
  const title = (name ?? "")
    .trim()
    .replace(/^footer\s*[—–-]\s*/i, "")
    .trim();
  return title || fallback;
}
