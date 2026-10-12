/**
 * PURE, no-DB PAGE block-composer catalog — the content-page surface's block TYPE list +
 * per-type CONFIG parse, built on the shared core in `block-model.ts`. A CMS page is an
 * ORDERED ARRAY OF BLOCK INSTANCES {id, type, visible, config} stored as JSON in the
 * `pages.blocks` column (the instance-based successor to the relational page_sections).
 *
 * The catalog is tuned for CONTENT pages (about / legal / Maison / landing): an INLINE
 * hero (its own image + copy — NOT the home's Bannières carousel), an HTML rich_text (the
 * workhorse for legal copy, sanitised at render), stats, timeline, gallery, plus the
 * shared editorial / cta_band / cards / steps / faq / banner and the catalogue blocks
 * (product grid, categories, brands). Media are médiathèque ids; catalogue
 * refs are slugs resolved at render — every link goes through its real source of truth.
 *
 * LAYOUTS (2026-10-01): most blocks carry a per-type `layout` variant (hero centered /
 * statement / split / compact, rich_text split / centered, stats ledger, timeline rail,
 * steps ladder / vertical, trust plain / tiles / numbered…) so pages built from the SAME
 * catalog can look genuinely different. Every variant's default reproduces the previous
 * look, and parsing runs on read, so stored blocks without a layout render unchanged.
 * Backend-linked blocks: `contact_channels` (reads « Identité & contact » settings),
 * `stores` (optional live link to a pickup location), `jobs` (apply e-mail falls back to
 * the site contact e-mail), and live stat sources (brand count, years since founding).
 *
 * Shared with the HOME composer through block-model.ts.
 */

import { safeHref } from "@/lib/utils/safe-href";
import { clampInt, coerceEnum, coerceMediaId } from "./boutique-landing-parse";
import {
  asBool,
  asStr,
  parseBlockList,
  parseCard,
  parseHeader,
  parseImage,
  parsePresentation,
  parseRefs,
  parseSource,
  serializeBlocks,
  type Block,
  type BlockCard,
  type BlockHeader,
  type BlockImage,
  type BlockPresentation,
  type ProductSource,
} from "./block-model";

// Re-export the shared pieces the page composer/renderer need from one import.
export {
  BLOCK_ALIGNS,
  BLOCK_BACKGROUNDS,
  BLOCK_PADDINGS,
  BLOCK_WIDTHS,
  DEFAULT_PRESENTATION,
  IMAGE_RECO,
  PRODUCT_SOURCE_MODES,
  newBlockId,
} from "./block-model";
export type { BlockImage, BlockPresentation, ProductSource } from "./block-model";

// ── Block type catalog ──────────────────────────────────────────────────────
export const PAGE_BLOCK_TYPES = [
  "hero", // inline page hero (own image + copy + 2 CTAs) — NOT the Bannières carousel
  "rich_text", // heading + sanitised HTML body (TipTap) — the content workhorse
  "editorial", // large image + text split
  "quote", // full-width manifesto / pull-quote with attribution
  "cta_band", // call-to-action band (image banner, or a compact bar without image)
  "stats", // key figures (manual or live: brand count, years since founding)
  "timeline", // dated timeline (vertical or horizontal rail)
  "gallery", // image grid
  "fifty_fifty", // image + text cards (1–3)
  "feature_cards", // dark feature cards
  "trust", // icon cards (boxed, plain, clickable tiles or numbered values)
  "steps", // numbered process (cards, connected ladder or vertical path)
  "faq", // question / answer accordion
  "banner", // single image banner with CTA
  "contact_channels", // phone / WhatsApp / e-mail / boutiques — live from the contact settings
  "stores", // boutique directory: address, hours, phone, itinerary + map
  "jobs", // open positions with e-mail application
  "tiers", // warranty / plan tier cards (eyebrow + big value + unit + body)
  "checklist", // titled include ✓ / exclude ✗ columns (conditions, couvert/non couvert)
  "legal_doc", // legal article: numbered sections + optional facts table + cookie prefs + sommaire
  "contact_form", // message form (subject chips + fields) — the « Nous écrire » surface
  "apply_form", // job-application form (CV upload + poste visé) — the recrutement surface
  "product_grid", // a filterable product grid (embed catalogue on a page)
  "categories", // category cards
  "brands", // brand logos
] as const;
export type PageBlockType = (typeof PAGE_BLOCK_TYPES)[number];

const PAGE_BLOCK_TYPE_SET: ReadonlySet<string> = new Set(PAGE_BLOCK_TYPES);

/** Palette metadata for the admin composer (label + one-line hint + group). */
export const PAGE_BLOCK_META: Record<
  PageBlockType,
  { label: string; hint: string; group: "contenu" | "média" | "éditorial" | "pratique" | "catalogue" }
> = {
  hero: { label: "En-tête (héro)", hint: "Ouverture de page : centré, manifeste typographique, scindé texte + visuel ou compact", group: "média" },
  rich_text: { label: "Texte enrichi", hint: "Titre + paragraphe riche — mise en page éditoriale (titre à gauche) ou colonne centrée", group: "contenu" },
  editorial: { label: "Éditorial (split)", hint: "Grande image + texte côte à côte, avec points clés optionnels", group: "éditorial" },
  quote: { label: "Citation / manifeste", hint: "Grande citation pleine largeur avec signature (fond sombre conseillé)", group: "éditorial" },
  cta_band: { label: "Bandeau CTA", hint: "Appel à l'action : bannière avec image, ou barre compacte sans image", group: "éditorial" },
  stats: { label: "Chiffres clés", hint: "Chiffres en cartes, en ligne ou en registre — manuels ou calculés en direct", group: "contenu" },
  timeline: { label: "Chronologie", hint: "Frise datée verticale ou horizontale (année + titre + description)", group: "contenu" },
  gallery: { label: "Galerie", hint: "Grille d'images", group: "média" },
  fifty_fifty: { label: "Cartes 50/50", hint: "Cartes image + texte (1 à 3)", group: "éditorial" },
  feature_cards: { label: "Cartes mises en avant", hint: "Cartes sombres (focus / points forts)", group: "éditorial" },
  trust: { label: "Réassurance / tuiles", hint: "Icône + titre : cartes, version épurée, tuiles cliquables ou valeurs numérotées", group: "éditorial" },
  steps: { label: "Étapes / processus", hint: "Étapes numérotées : cartes, échelle reliée ou parcours vertical", group: "éditorial" },
  faq: { label: "FAQ", hint: "Questions / réponses en accordéon", group: "contenu" },
  banner: { label: "Bannière", hint: "Une bannière image + texte + CTA", group: "média" },
  contact_channels: { label: "Canaux de contact", hint: "Téléphone, WhatsApp, e-mail, boutiques — valeurs reprises d'« Identité & contact »", group: "pratique" },
  stores: { label: "Boutiques", hint: "Annuaire des boutiques : adresse, horaires, téléphone, itinéraire et carte", group: "pratique" },
  jobs: { label: "Offres d'emploi", hint: "Postes ouverts (équipe, lieu, contrat) avec candidature par e-mail", group: "pratique" },
  tiers: { label: "Paliers / garanties", hint: "Cartes à grand chiffre (ex. « 12 mois ») — paliers de garantie ou d'offre", group: "éditorial" },
  checklist: { label: "Inclus / exclus", hint: "Colonnes de listes à puces ✓ incluses / ✗ exclues (conditions, couvert, non couvert)", group: "contenu" },
  legal_doc: { label: "Document légal", hint: "Article juridique : sections numérotées + sommaire, table d'identité et préférences cookies optionnelles", group: "contenu" },
  contact_form: { label: "Formulaire de contact", hint: "« Nous écrire » : choix du sujet + nom, téléphone, e-mail, message", group: "pratique" },
  apply_form: { label: "Formulaire de candidature", hint: "Postuler : nom, téléphone, e-mail, poste visé, CV et message", group: "pratique" },
  product_grid: { label: "Grille de produits", hint: "Grille filtrable de produits", group: "catalogue" },
  categories: { label: "Catégories", hint: "Cartes de catégories", group: "catalogue" },
  brands: { label: "Marques", hint: "Grille de marques (logos en direct)", group: "catalogue" },
};

// ── Layout variants (per type; index 0 = default = the previous look) ────────
export const HERO_LAYOUTS = ["centered", "statement", "split", "compact"] as const;
export const RICH_TEXT_LAYOUTS = ["auto", "split", "centered"] as const;
export const STATS_LAYOUTS = ["grid", "row", "ledger"] as const;
export const TIMELINE_LAYOUTS = ["vertical", "rail"] as const;
export const STEPS_LAYOUTS = ["cards", "ladder", "vertical"] as const;
export const TRUST_LAYOUTS = ["cards", "plain", "tiles", "numbered"] as const;
export const STORES_LAYOUTS = ["atlas", "salons", "directory"] as const;
export const CONTACT_LAYOUTS = ["concierge", "strip", "cards"] as const;
export const IMAGE_FITS = ["auto", "cover", "contain"] as const;
export type ImageFit = (typeof IMAGE_FITS)[number];

/** Composer labels for every layout variant (only types listed here show the selector). */
export const PAGE_BLOCK_LAYOUTS: Partial<Record<PageBlockType, { v: string; l: string }[]>> = {
  hero: [
    { v: "centered", l: "Centré (classique)" },
    { v: "statement", l: "Manifeste typographique" },
    { v: "split", l: "Scindé texte + visuel" },
    { v: "compact", l: "Compact pratique" },
  ],
  rich_text: [
    { v: "auto", l: "Automatique (éditorial si titre)" },
    { v: "split", l: "Éditorial — titre à gauche" },
    { v: "centered", l: "Colonne centrée (documents)" },
  ],
  stats: [
    { v: "grid", l: "Cartes" },
    { v: "row", l: "Ligne" },
    { v: "ledger", l: "Registre (sans cartes)" },
  ],
  timeline: [
    { v: "vertical", l: "Verticale" },
    { v: "rail", l: "Frise horizontale" },
  ],
  steps: [
    { v: "cards", l: "Cartes" },
    { v: "ladder", l: "Échelle reliée" },
    { v: "vertical", l: "Parcours vertical" },
  ],
  trust: [
    { v: "cards", l: "Cartes" },
    { v: "plain", l: "Épuré (sans cadres)" },
    { v: "tiles", l: "Tuiles cliquables" },
    { v: "numbered", l: "Valeurs numérotées" },
  ],
  stores: [
    { v: "atlas", l: "Atlas — liste + carte" },
    { v: "salons", l: "Salons — une boutique par section" },
    { v: "directory", l: "Annuaire sombre — cartes « Itinéraire »" },
  ],
  contact_channels: [
    { v: "concierge", l: "Conciergerie — titre + bureau de contact" },
    { v: "strip", l: "Bandeau compact" },
    { v: "cards", l: "Cartes — tuiles cliquables (appel, WhatsApp…)" },
  ],
};

/** Page rich_text carries sanitised HTML (from the TipTap editor) which can be long
 *  (a full legal page). It gets a much larger cap than the shared plain-text MAX_TEXT;
 *  sanitisation happens at RENDER (sanitizeRichHtml), never at parse. */
export const MAX_HTML = 50_000;
const asHtml = (v: unknown): string => (typeof v === "string" ? v.slice(0, MAX_HTML) : "");

/** A real link target, or "" — `safeHref` maps a BLANK value to "#", which would turn
 *  every unset CTA into a dead `href="#"` button (the renderer only links non-empty). */
export const realHref = (v: string | null | undefined): string => {
  const s = (v ?? "").trim();
  return s && s !== "#" ? s : "";
};
/** An in-page anchor id (`#sav`): lower-case slug, max 40 chars, "" when unusable. */
export const coerceAnchor = (v: unknown): string =>
  asStr(v)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);

/** Normalise the `#fragment` of an INTERNAL link with the same rule as block anchors, so
 *  a link typed « #Après-vente » still reaches the section saved as `id="apres-vente"`.
 *  A bare `#` (or empty fragment) is dropped. External urls are left untouched. */
export function normalizeFragment(href: string): string {
  if (!(href.startsWith("#") || href.startsWith("/"))) return href;
  const i = href.indexOf("#");
  if (i < 0) return href;
  const frag = coerceAnchor(href.slice(i + 1));
  const base = href.slice(0, i);
  return frag ? `${base}#${frag}` : base;
}
/** A safe, real, fragment-normalised link — or "" (never a dead `#`). */
export const cleanHref = (v: string | null | undefined): string => realHref(normalizeFragment(realHref(v)));
/** A loose e-mail shape check (shared by the jobs apply-e-mail and the per-store e-mail), so a
 *  non-address string is blanked rather than surfaced as a dead « mailto: » link. */
const isEmailish = (s: string): boolean => /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(s);
const linkStr = (v: unknown): string => {
  const s = asStr(v);
  return s ? cleanHref(safeHref(s)) : "";
};

/** Google Maps EMBED url guard (same rule as the « Identité & contact » map setting and
 *  the CSP frame-src allowlist): https + www/maps.google.com + an embed path. */
export function isGoogleMapsEmbedUrl(v: string): boolean {
  try {
    const u = new URL(v);
    const googleHost = u.hostname === "www.google.com" || u.hostname === "maps.google.com";
    const embedPath =
      u.pathname.startsWith("/maps/embed") ||
      (u.pathname.startsWith("/maps") && u.searchParams.get("output") === "embed");
    return u.protocol === "https:" && googleHost && embedPath;
  } catch {
    return false;
  }
}

export const STAT_SOURCES = ["manual", "brands", "years_since"] as const;
export type StatSource = (typeof STAT_SOURCES)[number];
export type StatItem = {
  label: string;
  value: string;
  caption: string;
  /** manual = `value`; brands = live count of active brands; years_since = current year
   *  minus `since` (e.g. 1950 → « 76 ans »). `value` stays the fallback when live data
   *  is unavailable. */
  source: StatSource;
  since: string;
};
export type TimelineItem = { year: string; title: string; description: string };
export type StepItem = { title: string; body: string; meta: string };
export type PointItem = { title: string; body: string };
export type ChipItem = { label: string; href: string };

export type StoreHours = { label: string; value: string };
export type StoreItem = {
  name: string;
  badge: string;
  address: string;
  city: string;
  phone: string;
  email: string;
  hours: StoreHours[];
  services: string[];
  note: string;
  /** Optional Google Maps EMBED url; blank → derived from the address at render. */
  mapEmbedUrl: string;
  image: BlockImage | null;
  /** Optional live link to a `pickup_locations` row: its name / address / city / phone /
   *  hours win at render (one source of truth with « Retrait en boutique »). */
  pickupLocationId: string;
};

export type JobItem = {
  title: string;
  team: string;
  location: string;
  contract: string;
  summary: string;
  missions: string;
  profile: string;
  /** Per-job application link (external posting / form / mailto). Blank → the block's
   *  « candidature par e-mail » (applyEmail, else the site contact e-mail). */
  applyHref: string;
  active: boolean;
};

export const CONTACT_CHANNEL_KEYS = ["phone", "whatsapp", "email", "stores", "help"] as const;
export type ContactChannelKey = (typeof CONTACT_CHANNEL_KEYS)[number];
export type ContactChannel = {
  key: ContactChannelKey;
  enabled: boolean;
  /** Optional label override (blank → the default label for the channel). */
  label: string;
  /** Short helper line under the value (blank → a sensible default, e.g. the hours). */
  note: string;
  /** stores / help only: the destination (blank → /apropos · /aide). */
  href: string;
};
export const CONTACT_CHANNEL_LABELS: Record<ContactChannelKey, string> = {
  phone: "Téléphone",
  whatsapp: "WhatsApp",
  email: "E-mail",
  stores: "Nos boutiques",
  help: "Aide & FAQ",
};
export const DEFAULT_CONTACT_CHANNELS: ContactChannel[] = CONTACT_CHANNEL_KEYS.map((key) => ({
  key,
  enabled: true,
  label: "",
  note: "",
  href: "",
}));

// ── tiers (warranty / plan paliers) ──────────────────────────────────────────
export const TIER_TONES = ["light", "dark", "brand"] as const;
export type TierTone = (typeof TIER_TONES)[number];
export type TierItem = {
  /** Small uppercase label above the figure (« Produits neufs »). */
  eyebrow: string;
  /** The big figure or word (« 12 », « Garantie Tokyo Store »). */
  value: string;
  /** Short unit beside a numeric value (« mois »); blank for a word value. */
  unit: string;
  body: string;
  tone: TierTone;
  /** Optional lucide icon key (rendered in a disc at the top). */
  icon: string;
};

// ── checklist (included ✓ / excluded ✗ columns) ───────────────────────────────
export const CHECKLIST_VARIANTS = ["include", "exclude"] as const;
export type ChecklistVariant = (typeof CHECKLIST_VARIANTS)[number];
export type ChecklistColumn = { title: string; variant: ChecklistVariant; items: string[] };

// ── legal_doc (numbered legal article + identity facts + cookie prefs) ─────────
/** One identity/legal fact row. `pending` → shown in the amber « à compléter » tone. */
export type FactItem = { label: string; value: string; pending: boolean };
/** One cookie category toggle. `locked` → always-on, non-togglable (Nécessaires). */
export type CookieCategory = { key: string; label: string; description: string; locked: boolean };
/** One numbered legal section (heading + ordered paragraphs). */
export type LegalSection = { heading: string; body: string[] };

// ── faq (enriched for the searchable help master/detail) ──────────────────────
/** A page FAQ item: the shared {question,answer} plus an optional topic key (for the
 *  filter chips) and an optional « en savoir plus » link. */
export type PageFaqItem = {
  question: string;
  answer: string;
  topic: string;
  linkLabel: string;
  linkHref: string;
};
/** A FAQ topic filter chip (key + label). An empty list → chips derived from items. */
export type FaqTopic = { key: string; label: string };

/** The per-type config union (loose: every field optional-with-default → never throws). */
export type PageBlockConfig = {
  header?: BlockHeader;
  presentation?: BlockPresentation;
  /** In-page anchor (`#sav`) set as the section id — links/tiles can jump to it. */
  anchor?: string;
  /** Per-type layout variant (see the *_LAYOUTS lists). */
  layout?: string;
  /** Italic second line of the title (« Chaque seconde » / « est un souvenir. »). */
  accent?: string;
  /** hero statement: oversized faint numeral behind the title (e.g. « 1950 »). */
  watermark?: string;
  /** hero: quick facts / chapter index, each optionally linked. */
  chips?: ChipItem[];
  /** rich_text / editorial / timeline / trust: chapter numeral shown with the heading (I, II…). */
  chapter?: string;
  /** hero / editorial / cta_band / banner / quote image slots. */
  image?: BlockImage | null;
  imageMobile?: BlockImage | null;
  imageSide?: "left" | "right";
  /** hero / editorial: cover (photo) vs contain-on-a-panel (product packshot); auto picks. */
  imageFit?: ImageFit;
  /** hero / cta_band: a second CTA alongside header.ctaLabel/ctaHref. */
  secondaryCtaLabel?: string;
  secondaryCtaHref?: string;
  /** rich_text: sanitised HTML body. editorial / hero / quote: plain text. */
  body?: string;
  /** quote: the signature line. */
  attribution?: string;
  /** rich_text alignment (centered layout). */
  alignment?: "left" | "center" | "right";
  /** cta_band visual style. */
  style?: "dark" | "light" | "brand";
  /** stats block. */
  stats?: StatItem[];
  /** timeline block. */
  timeline?: TimelineItem[];
  /** gallery block. */
  images?: BlockImage[];
  /** cards for fifty_fifty / feature_cards / trust. */
  cards?: BlockCard[];
  /** steps. */
  steps?: StepItem[];
  /** editorial: key points under the body. */
  points?: PointItem[];
  /** faq accordion / searchable help list. */
  faq?: PageFaqItem[];
  /** faq: topic filter chips (empty → derived from the items' topics). */
  faqTopics?: FaqTopic[];
  /** faq: show the search field + topic filter (the « Aide » master/detail). */
  faqSearch?: boolean;
  /** tiers: warranty / plan palier cards. */
  tiers?: TierItem[];
  /** checklist: titled include ✓ / exclude ✗ columns. */
  columns?: ChecklistColumn[];
  /** legal_doc: numbered sections. */
  sections?: LegalSection[];
  /** legal_doc: identity / legal facts table (shown above the sections). */
  facts?: FactItem[];
  /** legal_doc: cookie preference categories (shown after the sections). */
  cookiePrefs?: CookieCategory[];
  /** legal_doc: the amber « champs à compléter » editor note. */
  draftNote?: string;
  /** legal_doc: show the sticky « Sommaire » (table of contents) column. */
  showToc?: boolean;
  /** contact_form: selectable subjects (chips). */
  subjects?: string[];
  /** contact_form: show the optional « N° de commande » field. */
  showOrderField?: boolean;
  /** apply_form: « Poste visé » options (a « Candidature spontanée » is always appended). */
  jobOptions?: string[];
  /** apply_form: the data-consent line under the form. */
  consentText?: string;
  /** contact_form / apply_form: the confirmation shown after submit. */
  successTitle?: string;
  successBody?: string;
  /** contact_channels. */
  channels?: ContactChannel[];
  /** stores directory. */
  stores?: StoreItem[];
  showMap?: boolean;
  /** jobs board. */
  jobs?: JobItem[];
  /** jobs: application e-mail (blank → site contact e-mail). */
  applyEmail?: string;
  /** jobs: shown when no position is active. */
  emptyText?: string;
  /** jobs: the closing « candidature spontanée » panel (blank copy → defaults). */
  spontaneousEnabled?: boolean;
  spontaneousTitle?: string;
  spontaneousBody?: string;
  spontaneousCtaLabel?: string;
  /** contact_channels (concierge): show the hours + address lines under the intro. */
  showMeta?: boolean;
  /** catalogue blocks. */
  source?: ProductSource;
  count?: number;
  /** categories / brands featured slugs ([] = all / auto). */
  refs?: string[];
};

/** A placed page block instance. */
export type PageBlock = Block<PageBlockType, PageBlockConfig>;

// ── Parse / validate ─────────────────────────────────────────────────────────
export function parsePageBlockConfig(type: PageBlockType, raw: unknown): PageBlockConfig {
  const o = (raw ?? {}) as Record<string, unknown>;
  const anchor = coerceAnchor(o.anchor);
  return {
    ...parsePageBlockConfigBase(type, o),
    ...(anchor ? { anchor } : {}),
    presentation: parsePresentation(o.presentation),
  };
}

const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const rec = (v: unknown): Record<string, unknown> => (v ?? {}) as Record<string, unknown>;

function parseChips(v: unknown): ChipItem[] {
  return arr(v)
    .map((x) => {
      if (typeof x === "string") return { label: asStr(x).slice(0, 80), href: "" };
      const it = rec(x);
      return { label: asStr(it.label).slice(0, 80), href: linkStr(it.href) };
    })
    .filter((x) => x.label)
    .slice(0, 6);
}

function parseStore(v: unknown): StoreItem {
  const it = rec(v);
  const map = asStr(it.mapEmbedUrl);
  const pickup = coerceMediaId(it.pickupLocationId); // UUID-shape gate (same coercer)
  return {
    name: asStr(it.name).slice(0, 120),
    badge: asStr(it.badge).slice(0, 60),
    address: asStr(it.address).slice(0, 240),
    city: asStr(it.city).slice(0, 80),
    phone: asStr(it.phone).slice(0, 40),
    // Validate the shape so the « Écrire » button only renders for a usable address.
    email: ((e) => (isEmailish(e) ? e : ""))(asStr(it.email).slice(0, 160)),
    hours: arr(it.hours)
      .map((h) => ({ label: asStr(rec(h).label).slice(0, 60), value: asStr(rec(h).value).slice(0, 60) }))
      .filter((h) => h.label || h.value)
      .slice(0, 8),
    services: arr(it.services)
      .map((s) => asStr(s).slice(0, 60))
      .filter(Boolean)
      .slice(0, 8),
    note: asStr(it.note).slice(0, 400),
    mapEmbedUrl: map && isGoogleMapsEmbedUrl(map) ? map : "",
    image: parseImage(it.image),
    pickupLocationId: pickup ?? "",
  };
}

function parseJob(v: unknown): JobItem {
  const it = rec(v);
  return {
    title: asStr(it.title).slice(0, 120),
    team: asStr(it.team).slice(0, 60),
    location: asStr(it.location).slice(0, 80),
    contract: asStr(it.contract).slice(0, 60),
    summary: asStr(it.summary).slice(0, 400),
    missions: asStr(it.missions),
    profile: asStr(it.profile),
    // Sanitised at PARSE (linkStr = cleanHref ∘ safeHref) like every other link in this model,
    // so a javascript:/dead value never reaches the DB; the render re-checks defensively.
    applyHref: linkStr(it.applyHref),
    active: asBool(it.active, true),
  };
}

function parseChannels(v: unknown): ContactChannel[] {
  const seen = new Set<ContactChannelKey>();
  const out: ContactChannel[] = [];
  for (const x of arr(v)) {
    const it = rec(x);
    const key = coerceEnum(it.key, CONTACT_CHANNEL_KEYS, "phone");
    if (seen.has(key) || asStr(it.key) !== key) continue;
    seen.add(key);
    out.push({
      key,
      enabled: asBool(it.enabled, true),
      label: asStr(it.label).slice(0, 60),
      note: asStr(it.note).slice(0, 120),
      href: linkStr(it.href),
    });
  }
  // A never-configured block (no list) shows every channel in the default order.
  return out.length > 0 ? out : DEFAULT_CONTACT_CHANNELS.map((c) => ({ ...c }));
}

function parsePageBlockConfigBase(type: PageBlockType, o: Record<string, unknown>): PageBlockConfig {
  const header = parseHeader(o.header);
  // Normalise the header CTA so an unset/rejected link is "" (never a dead "#").
  header.ctaHref = cleanHref(header.ctaHref);
  const accent = asStr(o.accent).slice(0, 160);
  switch (type) {
    case "hero":
      return {
        header,
        layout: coerceEnum(o.layout, HERO_LAYOUTS, "centered"),
        accent,
        watermark: asStr(o.watermark).slice(0, 12),
        chips: parseChips(o.chips),
        image: parseImage(o.image),
        imageMobile: parseImage(o.imageMobile),
        imageFit: coerceEnum(o.imageFit, IMAGE_FITS, "auto"),
        body: asStr(o.body),
        secondaryCtaLabel: asStr(o.secondaryCtaLabel),
        secondaryCtaHref: linkStr(o.secondaryCtaHref),
      };
    case "rich_text":
      return {
        header,
        layout: coerceEnum(o.layout, RICH_TEXT_LAYOUTS, "auto"),
        chapter: asStr(o.chapter).slice(0, 12),
        accent,
        body: asHtml(o.body),
        alignment: coerceEnum(o.alignment, ["left", "center", "right"] as const, "left"),
      };
    case "editorial":
      return {
        header,
        accent,
        chapter: asStr(o.chapter).slice(0, 12),
        image: parseImage(o.image),
        imageMobile: parseImage(o.imageMobile),
        imageSide: coerceEnum(o.imageSide, ["left", "right"] as const, "right"),
        imageFit: coerceEnum(o.imageFit, IMAGE_FITS, "auto"),
        body: asStr(o.body),
        points: arr(o.points)
          .map((x) => ({ title: asStr(rec(x).title).slice(0, 120), body: asStr(rec(x).body).slice(0, 400) }))
          .filter((x) => x.title || x.body)
          .slice(0, 6),
      };
    case "quote":
      return {
        header,
        body: asStr(o.body).slice(0, 600),
        attribution: asStr(o.attribution).slice(0, 160),
        image: parseImage(o.image),
      };
    case "cta_band":
      return {
        header,
        accent,
        image: parseImage(o.image),
        imageMobile: parseImage(o.imageMobile),
        style: coerceEnum(o.style, ["dark", "light", "brand"] as const, "dark"),
        secondaryCtaLabel: asStr(o.secondaryCtaLabel),
        secondaryCtaHref: linkStr(o.secondaryCtaHref),
      };
    case "banner":
      return { header, image: parseImage(o.image), imageMobile: parseImage(o.imageMobile) };
    case "stats":
      return {
        header,
        layout: coerceEnum(o.layout, STATS_LAYOUTS, "grid"),
        stats: arr(o.stats)
          .map((x) => {
            const it = rec(x);
            return {
              label: asStr(it.label),
              value: asStr(it.value),
              caption: asStr(it.caption),
              source: coerceEnum(it.source, STAT_SOURCES, "manual"),
              since: asStr(it.since).replace(/[^0-9]/g, "").slice(0, 4),
            };
          })
          .filter((x) => x.label || x.value || x.source !== "manual")
          .slice(0, 8),
      };
    case "timeline":
      return {
        header,
        chapter: asStr(o.chapter).slice(0, 12),
        layout: coerceEnum(o.layout, TIMELINE_LAYOUTS, "vertical"),
        timeline: arr(o.timeline)
          .map((x) => {
            const it = rec(x);
            return { year: asStr(it.year), title: asStr(it.title), description: asStr(it.description) };
          })
          .filter((x) => x.year || x.title)
          .slice(0, 20),
      };
    case "gallery":
      return {
        header,
        images: arr(o.images)
          .map(parseImage)
          .filter((x): x is BlockImage => x !== null)
          .slice(0, 24),
      };
    case "fifty_fifty":
      return { header, cards: arr(o.cards).map(parseCardReal).slice(0, 3) };
    case "feature_cards":
      return { header, cards: arr(o.cards).map(parseCardReal).slice(0, 4) };
    case "trust":
      return {
        header,
        chapter: asStr(o.chapter).slice(0, 12),
        layout: coerceEnum(o.layout, TRUST_LAYOUTS, "cards"),
        cards: arr(o.cards).map(parseCardReal).slice(0, 8),
      };
    case "steps":
      return {
        header,
        accent,
        layout: coerceEnum(o.layout, STEPS_LAYOUTS, "cards"),
        steps: arr(o.steps)
          .map((x) => ({
            title: asStr(rec(x).title),
            body: asStr(rec(x).body),
            meta: asStr(rec(x).meta).slice(0, 60),
          }))
          .filter((x) => x.title || x.body)
          .slice(0, 8),
      };
    case "faq":
      return {
        header,
        faqSearch: asBool(o.faqSearch, false),
        faqTopics: arr(o.faqTopics)
          .map((x) => ({ key: coerceAnchor(rec(x).key), label: asStr(rec(x).label).slice(0, 40) }))
          .filter((x) => x.key && x.label)
          .slice(0, 12),
        faq: arr(o.faq)
          .map((x) => {
            const it = rec(x);
            return {
              question: asStr(it.question),
              answer: asStr(it.answer),
              topic: coerceAnchor(it.topic),
              linkLabel: asStr(it.linkLabel).slice(0, 80),
              linkHref: linkStr(it.linkHref),
            };
          })
          .filter((x) => x.question && x.answer)
          .slice(0, 30),
      };
    case "tiers":
      return {
        header,
        accent,
        tiers: arr(o.tiers)
          .map((x) => {
            const it = rec(x);
            return {
              eyebrow: asStr(it.eyebrow).slice(0, 60),
              value: asStr(it.value).slice(0, 40),
              unit: asStr(it.unit).slice(0, 24),
              body: asStr(it.body).slice(0, 400),
              tone: coerceEnum(it.tone, TIER_TONES, "light"),
              icon: asStr(it.icon).slice(0, 40),
            };
          })
          .filter((x) => x.value || x.eyebrow || x.body)
          .slice(0, 4),
      };
    case "checklist":
      return {
        header,
        columns: arr(o.columns)
          .map((x) => {
            const it = rec(x);
            return {
              title: asStr(it.title).slice(0, 120),
              variant: coerceEnum(it.variant, CHECKLIST_VARIANTS, "include"),
              items: arr(it.items)
                .map((s) => asStr(s).slice(0, 300))
                .filter(Boolean)
                .slice(0, 12),
            };
          })
          .filter((c) => c.title || c.items.length > 0)
          .slice(0, 3),
      };
    case "legal_doc":
      return {
        header,
        draftNote: asStr(o.draftNote).slice(0, 600),
        showToc: asBool(o.showToc, true),
        facts: arr(o.facts)
          .map((x) => {
            const it = rec(x);
            return {
              label: asStr(it.label).slice(0, 120),
              value: asStr(it.value).slice(0, 400),
              pending: asBool(it.pending, false),
            };
          })
          .filter((f) => f.label || f.value)
          .slice(0, 16),
        sections: arr(o.sections)
          .map((x) => {
            const it = rec(x);
            return {
              heading: asStr(it.heading).slice(0, 200),
              body: arr(it.body)
                .map((p) => asStr(p))
                .filter(Boolean)
                .slice(0, 12),
            };
          })
          .filter((s) => s.heading || s.body.length > 0)
          .slice(0, 30),
        cookiePrefs: arr(o.cookiePrefs)
          .map((x) => {
            const it = rec(x);
            return {
              key: coerceAnchor(it.key) || asStr(it.label).slice(0, 24).toLowerCase(),
              label: asStr(it.label).slice(0, 80),
              description: asStr(it.description).slice(0, 300),
              locked: asBool(it.locked, false),
            };
          })
          .filter((c) => c.label)
          .slice(0, 8),
      };
    case "contact_form":
      return {
        header,
        subjects: arr(o.subjects)
          .map((s) => asStr(s).slice(0, 40))
          .filter(Boolean)
          .slice(0, 8),
        showOrderField: asBool(o.showOrderField, true),
        successTitle: asStr(o.successTitle).slice(0, 120),
        successBody: asStr(o.successBody).slice(0, 400),
      };
    case "apply_form":
      return {
        header,
        jobOptions: arr(o.jobOptions)
          .map((s) => asStr(s).slice(0, 120))
          .filter(Boolean)
          .slice(0, 20),
        consentText: asStr(o.consentText).slice(0, 600),
        successTitle: asStr(o.successTitle).slice(0, 120),
        successBody: asStr(o.successBody).slice(0, 400),
      };
    case "contact_channels":
      return {
        header,
        accent,
        layout: coerceEnum(o.layout, CONTACT_LAYOUTS, "concierge"),
        showMeta: asBool(o.showMeta, true),
        channels: parseChannels(o.channels),
      };
    case "stores":
      return {
        header,
        accent,
        layout: coerceEnum(o.layout, STORES_LAYOUTS, "atlas"),
        showMap: asBool(o.showMap, true),
        stores: arr(o.stores)
          .map(parseStore)
          .filter((s) => s.name || s.address || s.pickupLocationId)
          .slice(0, 12),
      };
    case "jobs": {
      const email = asStr(o.applyEmail).slice(0, 160);
      return {
        header,
        accent,
        applyEmail: isEmailish(email) ? email : "",
        emptyText: asStr(o.emptyText).slice(0, 400),
        spontaneousEnabled: asBool(o.spontaneousEnabled, true),
        spontaneousTitle: asStr(o.spontaneousTitle).slice(0, 120),
        spontaneousBody: asStr(o.spontaneousBody).slice(0, 400),
        spontaneousCtaLabel: asStr(o.spontaneousCtaLabel).slice(0, 60),
        jobs: arr(o.jobs)
          .map(parseJob)
          .filter((j) => j.title)
          .slice(0, 20),
      };
    }
    case "product_grid":
      return { header, source: parseSource(o.source), count: clampInt(o.count, 8, 2, 24) };
    case "categories":
      return { header, refs: parseRefs(o.refs), count: clampInt(o.count, 12, 2, 40) };
    case "brands":
      return { header, refs: parseRefs(o.refs), count: clampInt(o.count, 12, 2, 40) };
    default:
      return { header };
  }
}

/** parseCard with its CTA link normalised to "" when unset (never a dead "#"). */
function parseCardReal(v: unknown): BlockCard {
  const c = parseCard(v);
  return { ...c, ctaHref: cleanHref(c.ctaHref) };
}

/** Parse the stored `pages.blocks` JSON into a clean, validated block list (drop unknown
 *  types, coerce each config, stable ids, 40-block cap). [] for absent/garbled input. */
export function parsePageBlocks(raw: string | null | undefined): PageBlock[] {
  const blocks = parseBlockList(
    raw,
    (t): t is PageBlockType => PAGE_BLOCK_TYPE_SET.has(t),
    parsePageBlockConfig,
  );
  // An anchor becomes a section id — keep only the FIRST block using it, so the page never
  // ships duplicate ids (a #link must resolve to one section). Dedup over VISIBLE blocks ONLY:
  // a hidden block emits no id, so it must neither reserve an anchor nor steal it from a later
  // visible block (else a #fragment / Sommaire / deep link would resolve to nothing).
  const seen = new Set<string>();
  for (const b of blocks) {
    if (!b.visible) continue;
    const a = b.config.anchor;
    if (!a) continue;
    if (seen.has(a)) delete b.config.anchor;
    else seen.add(a);
  }
  return blocks;
}

/** Serialise a page block list back to the stored JSON string (for the save action). */
export function serializePageBlocks(blocks: PageBlock[]): string {
  return serializeBlocks(blocks);
}

// ── Pure render helpers shared by the storefront renderer + tests ──────────────
/** « 76 ans » for a founding year, or null when the year is unusable. */
export function yearsSinceLabel(since: string, now: Date = new Date()): string | null {
  const y = Number.parseInt(since, 10);
  if (!Number.isFinite(y) || y < 1000) return null;
  const n = now.getFullYear() - y;
  return n > 0 ? `${n} ans` : null;
}

/** Google Maps embed + directions urls for an address (no API key needed). */
export function mapUrlsFor(address: string, city: string): { embed: string; directions: string } | null {
  const q = [address, city].map((s) => s.trim()).filter(Boolean).join(", ");
  if (!q) return null;
  const enc = encodeURIComponent(q);
  return {
    embed: `https://maps.google.com/maps?q=${enc}&z=15&output=embed`,
    directions: `https://www.google.com/maps/dir/?api=1&destination=${enc}`,
  };
}

/** tel: / wa.me targets from a configured phone number ("" when unusable). */
export function telHref(phone: string | null | undefined): string {
  const digits = (phone ?? "").replace(/[^\d+]/g, "");
  return digits.replace(/\D/g, "").length >= 6 ? `tel:${digits}` : "";
}
export function whatsappHref(phone: string | null | undefined): string {
  const digits = (phone ?? "").replace(/\D/g, "");
  return digits.length >= 8 ? `https://wa.me/${digits}` : "";
}
