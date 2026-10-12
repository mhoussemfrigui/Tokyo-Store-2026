/**
 * Storefront catalog DTOs.
 *
 * These are the plain, serializable shapes the UI renders. They currently come
 * from the bundled static JSON (`src/data/*.json`) via `src/lib/data`, but the
 * shape is the single contract every component and page depends on — so when the
 * real Tokyo Store backend is wired in, only the data *source* changes, not the
 * components.
 *
 * Field mapping to the main Tokyo Store platform DTO (`src/types/catalog.ts`
 * there), for the eventual backend swap:
 *   - `id`     ⇄ backend product id / externalRef
 *   - `slug`   ⇄ backend `slug` (canonical product URL key)
 *   - `title`  ⇄ backend `name`
 *   - `price`  ⇄ backend `priceCents` via `minorToDinars()` (see `src/lib/price.ts`)
 *   - `image`  ⇄ backend primary media URL
 * The mapping is done inside the data-source adapter (`src/lib/data/*`), so
 * components keep consuming this one shape.
 */
export type Product = {
  id: string;
  /** Store product code (backend SKU = migration feed g:id, e.g. "TS-14051").
   *  Shown as the PDP "Référence"; null when the product has no code. */
  sku?: string | null;
  /** URL-safe, unique key used for the flat `/[slug]` product route. */
  slug: string;
  title: string;
  link: string;
  image: string;
  price: number;
  /** Real compare-at / "was" price (dinars) when genuinely discounted; null/absent
   *  otherwise. Backend-sourced (stored old price or a live promotion) — never faked. */
  oldPrice?: number | null;
  currency: string;
  availability: "in_stock" | "out_of_stock" | string;
  condition: string;
  brand: string;
  /** Category slug this product belongs to (matches a `Category.slug`). */
  category: string;
  /** Breadcrumb-ish taxonomy path, e.g. "PC Gaming / Accessoires / Souris". */
  product_type: string;
  /** Real backend rating (0–5) + review count. 0 reviews ⇒ "not yet rated". */
  rating?: number;
  reviews?: number;
  /** Admin SEO overrides (meta title/description); absent ⇒ derived from title. */
  metaTitle?: string | null;
  metaDescription?: string | null;
  /** Full category SLUG chain root→leaf (migration tree). Lets a category page
   *  roll a product up to ANY ancestor, e.g. ["univers-apple","iphone","iphones-neufs"]. */
  category_path?: string[];
  /** Offered Tokyo Care protection plans for THIS product, with the per-unit price
   *  (dinars) resolved from the backend. Empty/absent = none offered. The plan
   *  details (name, duration, perks…) come from the care-plans catalogue, keyed by
   *  `id`. Backend-sourced snapshot — the charge is re-priced at checkout. */
  care?: { id: string; price: number }[];

  /* ─────────────────────────────────────────────────────────────────────────
   * PDP DETAIL FIELDS (optional) — NOT in the lightweight catalogue snapshot
   * (which stays card-sized for the client bundle). The flat-slug PDP route
   * enriches the ONE product being viewed with these, read LIVE from the
   * backend (RSC) via `getProductDetailBySlug`, so admin edits to description /
   * characteristics / gallery / variants appear immediately with no re-export.
   * Card/list/search/rail consumers never read these (always absent there).
   * ───────────────────────────────────────────────────────────────────────── */
  /** Full gallery image URLs (same-origin `/cdn`), primary first. Absent on cards. */
  images?: string[];
  /** Alt text parallel to `images` (same order/length). */
  imagesAlt?: string[];
  /** Alt text for the primary `image`. */
  imageAlt?: string;
  /** Short marketing description (admin "description courte"), HTML-free-ish. */
  shortDesc?: string;
  /** Long product description (admin "Présentation"), may contain blank-line paragraphs. */
  description?: string;
  /** Resolved warranty display string (global→category→product cascade). */
  warranty?: string;
  /** Warranty duration in months (for badges). */
  warrantyMonths?: number;
  /** Min units per order (≥1; null = no minimum) — drives the stepper floor. */
  minPurchaseQty?: number | null;
  /** Max units per order (≥1; null = no maximum) — caps the stepper. */
  maxPurchaseQty?: number | null;
  /** "simple" | "variable" — variable products carry `variants`. */
  productType?: "simple" | "variable";
  /** Active brand slug for linking to the flat brand URL; empty when none. */
  brandSlug?: string;
  /** "Caractéristiques clés" — operator-curated key-feature bullets (ordered,
   *  variable count), the primary source for the PDP highlight chips. Empty/absent
   *  ⇒ the PDP falls back to `specs`, then a derived marketing default. */
  highlights?: string[];
  /** Per-product characteristics ("Caractéristiques") — ordered attribute rows,
   *  the source for the PDP "Caractéristiques clés" cards + "Descriptif technique"
   *  grid. Generic over EVERY attribute kind (colour / select / multiselect /
   *  boolean / number / text) — colour values carry a swatch hex. */
  specs?: ProductSpec[];
  /** Variation axes of a `variable` product (one per attribute used as a variant
   *  axis), each with its selectable values. Generic over all value-list kinds:
   *  colour axes render as swatches, other kinds as labelled pills. Absent/empty
   *  for simple products. */
  variantAxes?: ProductVariantAxis[];
  /** The concrete variant combinations (one per axis-value tuple), carrying the
   *  per-combination stock / image / price so selecting values drives the gallery,
   *  availability and price. */
  variantCombos?: ProductVariantCombo[];
  /** Optional product video (YouTube/Vimeo/Dailymotion/embeddable URL or a direct
   *  .mp4). Admin "Vidéo produit" tab. The PDP renders the player only when set. */
  videoUrl?: string;
  /** Poster frame for the video (same-origin social/compat URL — safe for the raw
   *  `<video poster>`). Falls back to `ogImage` → primary image when absent. */
  videoPoster?: string | null;
  /** Alt text for the video poster media (Médiathèque), when a dedicated poster is set. */
  videoPosterAlt?: string | null;
  /** Operator-entered video heading (no fabricated default — renders only when set). */
  videoTitle?: string | null;
  /** Operator-entered video caption (renders only when set). */
  videoDescription?: string | null;
  /** Per-product FAQ (admin Catalogue → Produits → FAQ), published Q/A in order.
   *  The PDP renders these; a generic templated set is used ONLY when this is empty.
   *  Backend-sourced via `faqService.listByProductId` on the live PDP fetch. */
  faq?: { q: string; a: string }[];
  /** GTIN / barcode (EAN/UPC) — merchant identifier for JSON-LD + feeds. */
  gtin?: string | null;
  /** Manufacturer Part Number — merchant identifier for JSON-LD + feeds. */
  mpn?: string | null;
  /** Admin canonical-URL override (SEO tab). When set, the PDP points `rel=canonical`
   *  here instead of the default `/${slug}` — for a variant/duplicate pointing at a master. */
  canonicalUrl?: string | null;
  /** Admin per-product noindex (SEO tab). When true, the PDP emits `robots: noindex`. */
  noindex?: boolean;
  /** Official/brand URLs for `Product.sameAs` (SEO tab). Emitted only when the global
   *  `seo.product_sameas_enabled` switch is on (gated at the page). */
  sameAs?: string[];
  /** Admin OG-image override (SEO tab) resolved to a social-share URL; falls back to
   *  the primary image for the social card. */
  ogImage?: string | null;
  /** Publication instant (ISO) — used as the VideoObject `uploadDate` proxy and the
   *  Offer `validFrom` lower bound. */
  publishedAt?: string;
};

/** One characteristic row for the PDP "Caractéristiques" block (mirrors the
 *  backend `ProductSpec`, flattened for the storefront). Covers every attribute
 *  kind: value-list kinds fill `values` (colour adds `colorHex`), number/text
 *  fill `text`. */
export type ProductSpec = {
  /** Attribute display name, e.g. "Couleur", "Connectivité", "Étanchéité". */
  name: string;
  /** Attribute kind — one of select | multiselect | color | boolean | number | text. */
  kind: "select" | "multiselect" | "color" | "boolean" | "number" | "text" | string;
  /** Value-list values (label + swatch hex for colours; null hex otherwise); empty for number/text. */
  values: { label: string; colorHex: string | null }[];
  /** Scalar value for number/text kinds; null for value-lists. */
  text: string | null;
};

/** A variation axis (an attribute used to vary the product) + its selectable
 *  values. `kind === "color"` → render swatches with `colorHex`; other kinds →
 *  render labelled option pills. */
export type ProductVariantAxis = {
  attributeId: string;
  name: string;
  kind: "select" | "multiselect" | "color" | "boolean" | string;
  values: { id: string; label: string; colorHex: string | null }[];
};

/** One concrete variant combination — the storefront projection of the backend
 *  `ProductVariant`, carrying just what the gallery / selector / price UI needs. */
export type ProductVariantCombo = {
  id: string;
  /** Combination label, e.g. "Bleu" or "Bleu / 256 Go". */
  label: string;
  /** Attribute-value ids that define this combination (one per axis). */
  optionValueIds: string[];
  inStock: boolean;
  isDefault?: boolean;
  /** Per-variant image URL (same-origin `/cdn`), when the admin set one. */
  image?: string | null;
  /** Variant's own price in dinars (major unit), when it differs from the parent. */
  price?: number;
};

/** A Tokyo Care plan's presentational details (care-plans.json), keyed by `id`. */
export type CarePlanInfo = {
  id: string;
  name: string;
  durationMonths: number;
  perks: string[];
  icon: string | null;
  description: string | null;
};

export type Category = {
  slug: string;
  label: string;
  count: number;
};

/** A single PUBLISHED product review (backend `product_reviews`, status=approved). */
export type ProductReview = {
  id: string;
  author: string;
  rating: number; // 1..5
  title: string;
  body: string;
  /** Tied to a real, non-cancelled order → "Achat vérifié" badge. */
  verified: boolean;
  source: "customer" | "manual" | "ai";
  /** ISO date string (created_at). */
  date: string;
};

/** Reviews header aggregate: headline average + count + per-star counts (1..5). */
export type ProductReviewSummary = {
  count: number;
  average: number;
  distribution: Record<number, number>;
};
