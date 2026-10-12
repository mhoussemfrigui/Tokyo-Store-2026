import type { StaticImageData } from "next/image";

/**
 * Category slugs are DB-driven (the admin can create any category), so this
 * is an open string. The name survives as a semantic alias — call sites read
 * better with `CategorySlug` than a bare `string`. (Historically a closed
 * union of the original six Lovable categories, long since replaced by the
 * tokyostore.tn tree.)
 */
export type CategorySlug = string;

export type ProductImage = StaticImageData | string;

export type Product = {
  /**
   * Product UUID (`products.id`), set by the catalog mapper. The ONE GA4
   * `item_id` scheme: listing impressions / clicks send it like the PDP, cart and
   * purchase events do, so list → purchase attribution joins. Optional only for
   * hand-built objects; tracking falls back to the slug when absent.
   */
  id?: string;
  slug: string;
  name: string;
  brand: string;
  /**
   * Slug of the (active) brand, for linking to the flat brand URL `/<slug>`
   * (the old /brand/[slug] route permanently redirects there). Empty when none.
   */
  brandSlug?: string;
  category: CategorySlug;
  /** Display NAME of the primary (top-hop) category — for breadcrumbs. Falls
   *  back to the slug when absent. */
  categoryName?: string;
  /** Subcategory slug — must belong to the parent category. */
  subcategory?: string;
  platform?: string;
  /**
   * Internal SKU — shown on the PDP Détails tab. For a `variable` product
   * this is the parent SKU; each variant carries its own child SKU.
   */
  sku?: string;
  /** GTIN-8/12/13/14 (umbrella for UPC / EAN / ISBN). Feeds Merchant JSON-LD. */
  gtin?: string;
  /** Manufacturer Part Number. Feeds Merchant JSON-LD. */
  mpn?: string;
  /** Item condition (état): "new" (default) | "used" | "refurbished". Drives the
   *  PDP "État" row + schema.org Offer.itemCondition. */
  condition?: "new" | "used" | "refurbished";
  /** Product shape: "simple" (default) or "variable" (attribute variants). */
  productType?: "simple" | "variable";
  /** Min units the buyer must order (≥1; null/undefined = no minimum). Drives the
   *  PDP quantity stepper's floor + initial value so the default Add never errors. */
  minPurchaseQty?: number | null;
  /** Max units per order (≥1; null/undefined = no maximum; 1 = sold individually).
   *  Caps the PDP stepper. */
  maxPurchaseQty?: number | null;
  /**
   * Resolved warranty (global → category → product cascade), ready to show.
   * `warranty` is the display string ("Garantie 2 ans" / a custom label);
   * `warrantyMonths` is the duration for badges + tracking. Undefined ⇒ none.
   */
  warranty?: string;
  warrantyMonths?: number;
  /**
   * Variants of a `variable` product (empty/undefined for simple products).
   * Selecting one on the PDP drives the price / stock / SKU shown + the
   * variant added to the cart.
   */
  variants?: ProductVariant[];
  /** The variation axes (attributes + values) for the PDP picker. */
  variantOptions?: ProductVariantOption[];
  /**
   * @deprecated Lossy major-unit price (TND). Kept for display compatibility,
   * but for any arithmetic / analytics use `priceCents` to avoid sub-TND
   * precision loss. Equals `minorToDinars(priceCents)` (priceCents ÷ 1000).
   */
  price: number;
  /**
   * @deprecated Lossy major-unit old price (TND). Use `oldPriceCents` for
   * analytics. Equals `minorToDinars(oldPriceCents)` (oldPriceCents ÷ 1000).
   */
  oldPrice?: number;
  /** Canonical integer price in minor units (millimes, 1/1000 TND). Source of truth for analytics + payments. */
  priceCents: number;
  /** Canonical integer old price in minor units (millimes). `undefined` when there's no compare-at price. */
  oldPriceCents?: number;
  rating: number;
  reviews: number;
  /**
   * Publication instant (ISO 8601, `products.published_at`) — drives the
   * storefront « Nouveautés » sort (newest first, same order as the listing
   * index `published_at DESC NULLS LAST`). Undefined when never stamped, or on a
   * DTO cached before this field existed — such products sort last.
   */
  publishedAt?: string;
  image: ProductImage;
  /**
   * Alt text for the primary image — the Médiathèque `alt` of the first gallery
   * media, falling back to the product name. Always set when `image` is real.
   */
  imageAlt?: string;
  /**
   * Full gallery — primary first, additional images afterwards.
   * Falls back to `[image]` when the product has no extra `product_media`.
   */
  images?: ProductImage[];
  /**
   * Alt text parallel to `images` (same order, same length) — each entry is the
   * corresponding media's Médiathèque `alt`, falling back to the product name.
   */
  imagesAlt?: string[];
  /**
   * Compat (AVIF-avoiding) URL of the primary image, for OG / JSON-LD /
   * social previews where AVIF isn't reliably rendered. Falls back to
   * `image` when no media is linked. A per-product SEO "og image" override
   * (when set) wins over the auto-derived primary image.
   */
  ogImage?: string;
  /**
   * Compat (AVIF-avoiding, webp-first) parallel of `images` — same order/length.
   * Consumed by the product FEEDS (Google Merchant / ACP), which reject AVIF, so
   * the additional-image links never point at an .avif variant. The on-site
   * gallery keeps using `images` (AVIF-first display).
   */
  imagesSocial?: string[];
  /**
   * SEO overrides (admin "SEO" tab). All optional — `generateMetadata` and
   * the PDP fall back to sensible defaults when unset:
   *   metaTitle       → product name
   *   metaDescription → shortDesc (HTML stripped)
   *   canonicalUrl    → `${SITE_URL}/${slug}`
   *   noindex         → false (product stays indexable)
   */
  metaTitle?: string;
  metaDescription?: string;
  canonicalUrl?: string;
  noindex?: boolean;
  /**
   * Official external URLs (schema.org Product.sameAs) — parsed + validated to
   * absolute http(s) URLs (lib/seo/same-as.ts); `undefined` when the product
   * set none. This is pure data: the PDP emits it as Product.sameAs ONLY when
   * the global `seo.product_sameas_enabled` switch is on (the single gate).
   */
  sameAs?: string[];
  shortDesc: string;
  description: string;
  /** "Caractéristiques clés" — operator-curated key-feature bullets (ordered,
   *  variable count). Empty ⇒ none (PDP falls back to attribute specs). */
  highlights?: string[];
  inStock: boolean;
  /** Optional product video — YouTube URL (watch or short) or any embeddable URL. */
  videoUrl?: string;
  /** Optional poster image shown before the video plays. Falls back to product.image. */
  videoPoster?: ProductImage;
  /** Médiathèque alt for the video poster, when its media sets one. */
  videoPosterAlt?: string;
  /** Optional heading above the video player. Empty → no heading is rendered. */
  videoTitle?: string;
  /** Optional caption under the video heading. Empty → no caption is rendered. */
  videoDescription?: string;
};

/** One sellable variant of a variable product, exposed to the storefront. */
export type ProductVariant = {
  id: string;
  /** Human combination label, e.g. "Rouge / 512 Go". */
  label: string;
  sku?: string;
  /** Variant's OWN barcode (GTIN-8/12/13/14), if set. Product feeds emit this —
   *  never the parent's — so sibling variants can't share one g:gtin under a
   *  single item_group_id (a Merchant Center / ACP disapproval). */
  gtin?: string | null;
  priceCents: number;
  oldPriceCents?: number;
  inStock: boolean;
  /** `null` = untracked stock. */
  stockQty: number | null;
  /** The variant pre-selected on the PDP (admin-chosen default), if any. */
  isDefault?: boolean;
  /** Attribute value ids that define this variant (one per axis). */
  optionValueIds: string[];
  /**
   * Optional per-variant image (resolved URL) — the Médiathèque image set on
   * this variant. When present the PDP shows it on selection; absent ⇒ the
   * product gallery is used. `imageAlt` is the media alt, falling back to the
   * product name.
   */
  image?: string;
  imageAlt?: string;
  /** Compat (AVIF-avoiding) parallel of `image` for the product feeds — the
   *  variant row's primary image_link must not be an .avif Merchant rejects. */
  imageSocial?: string;
};

/**
 * A variant is effectively buyable when its `in_stock` flag is set AND it is
 * not a tracked-but-zero line. `stockQty === null` = untracked → always
 * sellable while in stock. Mirrors the order-time oversell guard so the PDP /
 * cards never advertise a variant that can't be fulfilled.
 */
export function variantInStock(v: { inStock: boolean; stockQty: number | null }): boolean {
  return v.inStock && (v.stockQty == null || v.stockQty > 0);
}

/** A variation axis (one attribute) + its selectable values, for the picker. */
export type ProductVariantOption = {
  attributeId: string;
  name: string;
  values: { id: string; label: string }[];
};

export type Subcategory = {
  slug: string;
  name: string;
  count?: number;
  /** Nested children — the tree goes up to 4 levels deep (Montres →
   *  Homme → Plongée → Submariner). Absent/empty = leaf. */
  children?: Subcategory[];
  /**
   * Editable listing chip icon (see @/lib/catalog/chip-icons). `icon` is the
   * admin-chosen lucide key; `iconMediaId` is an optional custom médiathèque
   * image id (carried so the server can batch-resolve it); `iconUrl` is that
   * resolved image URL, attached server-side and read by the drill-down chips.
   */
  icon?: string | null;
  iconMediaId?: string | null;
  iconUrl?: string | null;
};

export type Category = {
  slug: CategorySlug;
  name: string;
  tagline: string;
  count: number;
  subcategories: Subcategory[];
  /** Admin "ne pas indexer" flag — lets the sitemap exclude noindexed categories.
   *  Optional: synthetic category-shaped views (brand) omit it. */
  noindex?: boolean;
  /**
   * Editable listing chip icon (see @/lib/catalog/chip-icons) — the admin-chosen
   * lucide key + an optional custom médiathèque image id. Used when a root
   * category appears as a sibling chip; the URL is batch-resolved server-side.
   */
  icon?: string | null;
  iconMediaId?: string | null;
  /** The category's « Image boutique » (médiathèque id) — its tile visual on /boutique and
   *  the home « Catégories » block. Unset ⇒ a typographic panel (never the chip icon). */
  boutiqueImageMediaId?: string | null;
};

/**
 * Returns the URL string of a ProductImage, regardless of whether it was
 * imported statically (StaticImageData) or supplied by the backend as a
 * plain URL. Use this for meta tags and other contexts that need a raw URL.
 */
export function imageUrl(img: ProductImage): string {
  return typeof img === "string" ? img : img.src;
}
