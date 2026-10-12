/**
 * Demo / import content.
 *
 * The CATALOGUE is the Tokyo Store MIGRATION DATA — there is no separate demo
 * feed. `src/workflows/demo/import-demo.ts` imports the bundled migration feed
 * (`public/demo-assets/tokyostore.xml`) through the standard import pipeline, so
 * products, taxonomy (see `src/lib/db/catalog-tree.ts`), brands, SKU (feed g:id)
 * and meta all come from the migration data. The arrays below are the small
 * CHROME the migration feed does not carry (identity settings, footer nav, help
 * FAQs). Watch-era fixtures (home editorial blocks,
 * marketing banners, per-brand/category editorials, demo attributes/customers)
 * were removed — that content is not in the migration data and only ever fed the
 * retired legacy chrome.
 *
 * Every entity uses a stable key so the import is idempotent (slug for brands,
 * key for settings, slug for FAQ categories, question for FAQs). Existing rows
 * are skipped; editorial/SEO fields are filled only while blank.
 *
 * ⚠ The CLEAN side is NOT slug-scoped for content: the clean segments
 * (`src/workflows/data/segments.ts`) wipe EVERY product/brand/banner/menu/FAQ/
 * attribute. Only the settings (reset while still equal to the values below —
 * see `settings-clean-plan.ts`) and the loyalty / « Partenaire » tiers (by name)
 * are scoped by these lists.
 */

import {
  FOOTER_COLUMN_DEFAULTS,
  MAISON_EXPLORE_DEFAULTS,
  MAISON_EXPLORE_MENU_KEY,
} from "@/lib/cms/nav-menus";

// ─── images ────────────────────────────────────────────────────────────────
// Filenames inside `public/demo-assets/`. The workflow uploads each to the
// object store via the standard media pipeline. Only the Tokyo brand logo
// remains — the watch-era marketing imagery was removed with the chrome it fed.

export const DEMO_IMAGES = {
  // Brand wordmark (nav logo fallback, seeded into site.logo_media_id).
  logoPng: "tokyo-logo.png",
} as const;

export type DemoImageKey = keyof typeof DEMO_IMAGES;

// ─── brands ────────────────────────────────────────────────────────────────
// The REAL Tokyo marques, taken from the migration data (the live catalogue the
// feed built). The product import also find-or-creates brands from the feed, so
// this pre-seed just lets `db:seed:catalog` and the chrome phase show the marques
// before the async product import lands. Idempotent by slug.

export const DEMO_BRANDS: { slug: string; name: string }[] = [
  { slug: "apple", name: "Apple" },
  { slug: "samsung", name: "Samsung" },
  { slug: "earldom", name: "EARLDOM" },
  { slug: "xiaomi", name: "Xiaomi" },
  { slug: "green-lion", name: "Green Lion" },
  { slug: "havit", name: "HAVIT" },
  { slug: "nintendo", name: "Nintendo" },
  { slug: "karl-lagerfeld", name: "Karl Lagerfeld" },
  { slug: "jbl", name: "JBL" },
  { slug: "sony", name: "Sony" },
  { slug: "spirit-of-gamer", name: "Spirit Of Gamer" },
  { slug: "colmi", name: "Colmi" },
  { slug: "levelo", name: "Levelo" },
  { slug: "infinix", name: "Infinix" },
  { slug: "belkin", name: "Belkin" },
  { slug: "dobe", name: "Dobe" },
  { slug: "kadiou", name: "KadiOu" },
  { slug: "ea-sports", name: "EA SPORTS" },
  { slug: "sony-interactive-entertainment", name: "Sony Interactive Entertainment" },
  { slug: "ubisoft", name: "Ubisoft" },
  { slug: "2k-games", name: "2K Games" },
  { slug: "aqirys", name: "AQIRYS" },
  { slug: "borofone", name: "Borofone" },
  { slug: "fujifilm", name: "Fujifilm" },
  { slug: "honor", name: "Honor" },
  { slug: "spigen", name: "Spigen" },
  { slug: "tadamall", name: "Tadamall" },
  { slug: "bandai-namco-entertainment", name: "Bandai Namco Entertainment" },
  { slug: "inkax", name: "Inkax" },
  { slug: "nothing", name: "Nothing" },
  { slug: "oppo", name: "OPPO" },
  { slug: "powerology", name: "Powerology" },
  { slug: "riot-games", name: "Riot Games" },
  { slug: "epic-games-inc", name: "Epic Games Inc" },
  { slug: "onemust", name: "OneMust" },
  { slug: "smart-watch-band", name: "Smart Watch Band" },
  { slug: "square-enix", name: "Square Enix" },
  { slug: "microsoft", name: "Microsoft" },
  { slug: "porodo", name: "Porodo" },
  { slug: "roblox-corporation", name: "Roblox Corporation" },
  { slug: "smartec", name: "Smartec" },
  { slug: "usams", name: "USAMS" },
  { slug: "warner-bros-interactive", name: "Warner Bros. Interactive" },
  { slug: "rockstar-games", name: "Rockstar Games" },
  { slug: "sega", name: "Sega" },
  { slug: "watch-band", name: "Watch Band" },
  { slug: "activision", name: "Activision" },
  { slug: "capcom", name: "Capcom" },
  { slug: "guess", name: "Guess" },
  { slug: "nokia", name: "Nokia" },
  { slug: "unipro", name: "Unipro" },
  { slug: "valve-corporation", name: "Valve Corporation" },
  { slug: "konami", name: "Konami" },
  { slug: "kontrolfreek", name: "KontrolFreek" },
  { slug: "mojang", name: "Mojang" },
  { slug: "hoco", name: "Hoco" },
  { slug: "kieslect", name: "Kieslect" },
  { slug: "play-station-studio", name: "Play Station Studio" },
  { slug: "redragon", name: "Redragon" },
  { slug: "viva-madrid", name: "Viva Madrid" },
  { slug: "ipega", name: "iPega" },
  { slug: "msi", name: "MSI" },
  { slug: "netherrealm-studios", name: "NetherRealm Studios" },
  { slug: "plokama", name: "PLOKAMA" },
  { slug: "team17", name: "Team17" },
  { slug: "xo-simple-is-beauty", name: "XO (Simple is Beauty)" },
  { slug: "bose", name: "Bose" },
  { slug: "deadskull", name: "DeadSkull" },
  { slug: "hoguo", name: "HOGUO" },
  { slug: "koosda", name: "Koosda" },
  { slug: "miqia", name: "MIQIA" },
  { slug: "marvel", name: "Marvel" },
  { slug: "milestone", name: "Milestone" },
  { slug: "raptic", name: "Raptic" },
];

// ─── products ──────────────────────────────────────────────────────────────
// Catalog products are NOT fixtures. The demo push imports the bundled Tokyo
// migration feed (public/demo-assets/tokyostore.xml, ~2.6k products) through the
// standard import pipeline — see src/workflows/demo/import-demo.ts. Categories
// come from CATALOG_TREE (src/lib/db/catalog-tree.ts, the migration taxonomy).

// ─── banners ───────────────────────────────────────────────────────────────
// Marketing banners were watch-era chrome that only rendered on the retired
// legacy home/mega-menu — removed. The hero carousel slides (home_hero) are now
// edited in « Contenu & Design → Page d'accueil »; the footer banner in « Footer ».

export type DemoBannerPlacement =
  | "home_hero"
  | "header_strip"
  | "category_grid"
  | "footer";

export type DemoBanner = {
  name: string;
  placement?: DemoBannerPlacement;
  eyebrow?: string;
  title: string;
  subtitle?: string;
  description?: string;
  ctaLabel?: string;
  ctaHref?: string;
  secondaryCtaLabel?: string;
  secondaryCtaHref?: string;
  image: DemoImageKey;
  displayOrder: number;
};

export const DEMO_BANNERS: DemoBanner[] = [];

// ─── FAQ entries (the help-page set) ───────────────────────────────────────

export type DemoFaq = {
  categorySlug: string; // matches a faq_categories.slug
  question: string;
  answer: string;
  displayOrder: number;
};

export const DEMO_FAQ_CATEGORIES: { slug: string; name: string; displayOrder: number }[] = [
  { slug: "livraison", name: "Livraison", displayOrder: 0 },
  { slug: "retours", name: "Retours", displayOrder: 1 },
  { slug: "garantie", name: "Garantie", displayOrder: 2 },
  { slug: "paiement", name: "Paiement", displayOrder: 3 },
  { slug: "commandes", name: "Commandes", displayOrder: 4 },
];

export const DEMO_FAQS: DemoFaq[] = [
  {
    categorySlug: "livraison",
    question: "Quels sont les délais de livraison ?",
    answer:
      "La livraison standard prend 24 à 48h partout en Tunisie. La livraison est offerte au-delà du seuil affiché au panier ; le retrait en boutique est gratuit.",
    displayOrder: 0,
  },
  {
    categorySlug: "retours",
    question: "Comment retourner un produit ?",
    answer:
      "Lancez la procédure depuis votre espace client — nous organisons le retour, échange ou remboursement selon les conditions indiquées sur la fiche produit.",
    displayOrder: 1,
  },
  {
    categorySlug: "garantie",
    question: "Quelle est la durée de garantie ?",
    answer:
      "Tous nos produits neufs sont couverts par la garantie du fabricant (durée indiquée sur chaque fiche). Tokyo Store gère le SAV de bout en bout via l'atelier Tokyo Repair.",
    displayOrder: 2,
  },
  {
    categorySlug: "paiement",
    question: "Quels moyens de paiement acceptez-vous ?",
    answer:
      "Carte bancaire via Flouci, et paiement à la livraison partout en Tunisie.",
    displayOrder: 3,
  },
  {
    categorySlug: "commandes",
    question: "Puis-je modifier ma commande après validation ?",
    answer:
      "Tant que votre commande n'est pas en cours de préparation, oui — depuis votre espace client. Au-delà, contactez le support pour évaluer les options.",
    displayOrder: 4,
  },
];

// ─── per-product FAQs ──────────────────────────────────────────────────────
// Admin-driven; the migration feed ships no curated FAQ pairs — empty seed.

export type DemoProductFaq = {
  productSlug: string;
  question: string;
  answer: string;
  displayOrder: number;
  isPublished: boolean;
};

export const DEMO_PRODUCT_FAQS: DemoProductFaq[] = [];

// ─── per-category FAQs ─────────────────────────────────────────────────────
// Admin-driven; not carried by the migration feed — empty seed.

export type DemoCategoryFaq = {
  categorySlug: string;
  question: string;
  answer: string;
  displayOrder: number;
  isPublished: boolean;
};

export const DEMO_CATEGORY_FAQS: DemoCategoryFaq[] = [];

// ─── site settings (key/value typed) ───────────────────────────────────────

export type DemoSetting = {
  key: string;
  value: string;
  type: "text" | "number" | "boolean" | "media";
  groupKey: string;
  label: string;
};

export const DEMO_SETTINGS: DemoSetting[] = [
  { key: "site.name", label: "Nom du site", value: "Tokyo Store", type: "text", groupKey: "branding" },
  { key: "site.tagline", label: "Tagline", value: "Votre expert en produits technologiques de pointe", type: "text", groupKey: "branding" },
  { key: "site.description", label: "Description publique (footer)", value: "Produits high-tech, smartphones, gaming et accessoires — sélectionnés pour le passionné de technologie.", type: "text", groupKey: "branding" },
  // Contact — multi-value lists (JSON array of { v: value, f: show-in-footer }) +
  // the legacy single PRIMARY key (= first entry) for single-value consumers
  // (invoice / SEO / llms / email brand). No physical addresses are seeded (none
  // are published for the store; admins add any from CMS → Réglages).
  { key: "site.contact_phones", label: "Téléphones", value: '[{"v":"+216 50 059 160","f":true}]', type: "text", groupKey: "contact" },
  { key: "site.contact_phone", label: "Téléphones — principal", value: "+216 50 059 160", type: "text", groupKey: "contact" },
  { key: "site.contact_emails", label: "Emails de contact", value: '[{"v":"contact@tokyostore.tn","f":true}]', type: "text", groupKey: "contact" },
  { key: "site.contact_email", label: "Emails de contact — principal", value: "contact@tokyostore.tn", type: "text", groupKey: "contact" },
  // Socials — the ONE ordered-array key (« Identité & contact ») the editor and
  // every consumer (footer, coming-soon scene, reels, SEO sameAs, email brand)
  // read. Shape = serializeSocialList: [{ p: platform, u: url, l?: label }]. Many
  // links per platform are supported; the demo seeds one each, in canonical order.
  {
    key: "social.links",
    label: "Réseaux sociaux",
    value:
      '[{"p":"instagram","u":"https://instagram.com/tokyostore"},{"p":"facebook","u":"https://facebook.com/tokyostore"},{"p":"tiktok","u":"https://tiktok.com/@tokyostore"}]',
    type: "text",
    groupKey: "social",
  },
];

// ─── home design / nav logo ─────────────────────────────────────────────────
// The luxury editorial home blocks + mega-menu featured banners were watch-era
// chrome for the retired legacy home — removed. The live Tokyo storefront home is
// fixed components over the catalogue. Only the nav-bar logo remains.

/** Nav-bar logo: upload this image, store its media id under `site.logo_media_id`. */
export const DEMO_LOGO_SETTING: { settingKey: string; image: DemoImageKey } = {
  settingKey: "site.logo_media_id",
  image: "logoPng",
};

// ─── navigation menus (footer columns + « Explorer la maison ») ───────────

export type DemoNavItem = {
  label: string;
  /** Optional sub-title (nav_items.description) — the « Explorer la maison » hint. */
  description?: string;
  href?: string;
  internalKind?: "category" | "page" | "product";
  internalRef?: string;
};

export type DemoNavMenu = {
  key: string;
  name: string;
  description?: string;
  items: DemoNavItem[];
};

export const DEMO_NAV_MENUS: DemoNavMenu[] = [
  // The three footer link columns — same built-in links the storefront footer
  // ships with (single source: FOOTER_COLUMN_DEFAULTS), so the demo store's
  // footer matches a fresh install's and the component fallback, pixel-for-pixel.
  ...FOOTER_COLUMN_DEFAULTS.map((col) => ({
    key: col.key,
    name: col.title,
    description: "Colonne du pied de page.",
    items: col.items.map((it) => ({ label: it.label, href: it.href })),
  })),
  // « Explorer la maison » — the index at the foot of the Maison & legal pages.
  {
    key: MAISON_EXPLORE_MENU_KEY,
    name: MAISON_EXPLORE_DEFAULTS.name,
    description: MAISON_EXPLORE_DEFAULTS.description,
    items: MAISON_EXPLORE_DEFAULTS.items.map((it) => ({
      label: it.label,
      description: it.hint,
      href: it.href,
    })),
  },
];

// ─── product attributes ────────────────────────────────────────────────────
// The migration feed carries no structured attribute taxonomy, so no demo
// attributes are seeded (the watch Genre/Mouvement/bracelet set was removed).
// Admins define attributes + filters from /admin/catalog/attributes.

export type DemoAttribute = {
  slug: string;
  name: string;
  kind: "select" | "multiselect";
  displayOrder: number;
  values: { slug: string; label: string; displayOrder: number }[];
};

export const DEMO_ATTRIBUTES: DemoAttribute[] = [];

export type DemoProductAttribute = {
  productSlug: string;
  attributeSlug: string;
  valueSlug: string;
};

export const DEMO_PRODUCT_ATTRIBUTES: DemoProductAttribute[] = [];

export type DemoCategoryAttributeFilter = {
  categorySlug: string;
  attributeSlug: string;
  displayOrder: number;
};

export const DEMO_CATEGORY_ATTRIBUTE_FILTERS: DemoCategoryAttributeFilter[] = [];

// ─── editorial content ─────────────────────────────────────────────────────
// Per-category and per-brand editorial blocks were watch-era authored copy, not
// part of the migration data — removed. Admins add editorial/SEO from the
// category / brand forms.

export type DemoEditorialValueProp = {
  icon: string; // lucide icon name
  title: string;
  body: string;
};

export type DemoCategoryEditorial = {
  slug: string;
  eyebrow: string;
  title: string;
  body: string;
  valueProps: DemoEditorialValueProp[];
};

export const DEMO_CATEGORY_EDITORIALS: DemoCategoryEditorial[] = [];

export type DemoBrandEditorial = {
  slug: string;
  tagline: string;
  eyebrow: string;
  title: string;
  body: string;
  metaTitle: string;
  metaDescription: string;
  valueProps: DemoEditorialValueProp[];
};

export const DEMO_BRAND_EDITORIALS: DemoBrandEditorial[] = [];

// ─── customer profiles ─────────────────────────────────────────────────────
// Demo customer fixtures were watch-era — removed (not part of the migration
// data). Admins/customers create real profiles.

export type DemoCustomerProfile = {
  firstName: string;
  lastName: string;
  phone?: string | null;
  marketingOptIn: boolean;
  adminNotes: string;
};

export const DEMO_CUSTOMER_PROFILES: DemoCustomerProfile[] = [];

// ─── demo order (with a partial refund) ────────────────────────────────────
// Produced on demand via the admin UI now — no fixture (the old one referenced
// watch products that no longer exist).

export type DemoOrderItem = {
  productSlug: string;
  quantity: number;
  unitPriceCents: number;
};

export type DemoOrder = {
  orderNumber: string;
  contactEmail: string;
  contactPhone: string | null;
  customerFirstName: string;
  customerLastName: string;
  shipFullName: string;
  shipStreet: string;
  shipCity: string;
  shipRegion: string;
  shipPostalCode: string;
  paymentMethod: "flouci" | "clictopay" | "cod" | "card_stripe";
  paymentReference: string;
  items: DemoOrderItem[];
  refund: {
    amountCents: number;
    reason: string;
  };
};

export const DEMO_ORDERS: DemoOrder[] = [];
