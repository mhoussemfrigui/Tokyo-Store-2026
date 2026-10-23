import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

import { id, softDelete, timestamps } from "@/lib/db/columns";

/**
 * Product shape:
 *   simple   — one sellable unit (the default).
 *   variable — sells through attribute-defined variants, each with its own
 *              child SKU / price / stock (see `product_variants` below).
 */
export const productTypeEnum = pgEnum("product_type", ["simple", "variable"]);

/**
 * How the storefront "Vous aimerez aussi" rail is populated for a product:
 *   auto             — derived heuristic (category siblings → brand → recent), the default
 *   same_subcategory — random products from the same primary category
 *   same_brand       — random products from the same brand
 *   mixed            — random from same category ∪ same brand
 *   ai               — AI-picked complementary products (curated list in product_related)
 *   manual           — hand-picked products (curated list in product_related)
 */
export const PRODUCT_RELATED_MODES = [
  "auto",
  "same_subcategory",
  "same_brand",
  "mixed",
  "ai",
  "manual",
] as const;
export type ProductRelatedMode = (typeof PRODUCT_RELATED_MODES)[number];

/** Item condition (état). CHECK-constrained to this set in migration 0077. */
export const PRODUCT_CONDITIONS = ["new", "used", "refurbished"] as const;
export type ProductCondition = (typeof PRODUCT_CONDITIONS)[number];

/**
 * Product module.
 *
 * Cross-module relations (category, brand, images) live in `src/associations/`.
 * Single-module 1:n relations (variants, variant↔value links) stay here
 * (variants are defined below in this file).
 *
 * Money rule: `*_cents` columns hold integer minor units = MILLIMES
 * (1 TND = 1000 — see src/lib/price.ts). The `_cents` name is legacy and
 * was never renamed.
 */
export const products = pgTable(
  "products",
  {
    id: id(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    /** Legacy free-text tag — superseded by attributes (kept for old rows). */
    platform: text("platform"),
    /**
     * Product identification:
     *   sku   — internal SKU. For a `variable` product this doubles as the
     *           PARENT SKU that groups its variants; each variant then carries
     *           its own child SKU.
     *   gtin  — GTIN-8/12/13/14, the umbrella standard for UPC-12 / EAN-13 /
     *           ISBN. Stored as text to preserve leading zeros.
     *   mpn   — Manufacturer Part Number.
     */
    sku: text("sku"),
    gtin: text("gtin"),
    mpn: text("mpn"),
    /** Item condition (état) — drives Offer.itemCondition + the PDP "État" row.
     *  CHECK-constrained to PRODUCT_CONDITIONS in migration 0077. */
    condition: text("condition").$type<ProductCondition>().notNull().default("new"),
    /**
     * external_ref — a stable, opaque code from an EXTERNAL system (ERP / PIM /
     * marketplace) for linking & syncing this product BY REFERENCE over the API.
     * Unique among live products (partial unique index, like sku/gtin); kept
     * distinct from `sku` so the integration key can diverge from the SKU.
     */
    external_ref: text("external_ref"),

    /**
     * Product shape:
     *   product_type — `simple` or `variable` (attribute-driven variants).
     */
    product_type: productTypeEnum("product_type").notNull().default("simple"),

    /**
     * Warranty override (most-specific level of the global → category →
     * product cascade). `warranty_months` NULL = inherit from the category,
     * then the global default; a value (incl. 0 = "explicitly none") overrides.
     * `warranty_label` is optional custom copy ("Garantie constructeur") that
     * replaces the auto "Garantie X mois" when set.
     */
    warranty_months: integer("warranty_months"),
    warranty_label: text("warranty_label"),
    /** TVA rate override in basis points (1900 = 19%). NULL = inherit the
     *  cascade (filter → brand → category → global). See @/lib/tax. */
    tax_rate_bps: integer("tax_rate_bps"),

    short_desc: text("short_desc").notNull().default(""),
    description: text("description").notNull().default(""),

    /**
     * "Caractéristiques clés" — operator-curated key-feature bullets shown on the
     * PDP (the « Neuf · testé… / Facture officielle… » chips). Ordered, VARIABLE
     * count (not capped at 3), free-text strings. Empty [] = none → the PDP falls
     * back to attribute specs, then a derived marketing default. Re-added (migration
     * 0209) after 0102 dropped the original `product_highlights` table; a jsonb
     * array keeps order without a child table. See storefront keyFeatures().
     */
    highlights: jsonb("highlights").$type<string[]>().notNull().default(sql`'[]'::jsonb`),

    price_cents: integer("price_cents").notNull(),
    old_price_cents: integer("old_price_cents"),
    // LEGACY per-product currency. Display currency is now STORE-GLOBAL
    // (Commandes → Devises / getActiveCurrency); this column is frozen at its
    // 'TND' default — the per-product selector was removed. Kept to avoid a
    // destructive migration.
    currency: text("currency").notNull().default("TND"),

    /** Denormalised from product_reviews — recomputed by the review module
     *  on every review write (see catalog/review/service). */
    rating: numeric("rating", { precision: 3, scale: 2 }).notNull().default("0"),
    reviews_count: integer("reviews_count").notNull().default(0),

    in_stock: boolean("in_stock").notNull().default(true),
    stock_qty: integer("stock_qty"),
    /** Per-order purchase-quantity limits, aggregated across a product's variant
     *  lines (place-order sums the qty by product before checking, so the cap
     *  can't be split across variants). NULL = no limit. `max_purchase_qty = 1`
     *  = "sold individually". Enforced authoritatively at place-order +
     *  pre-checked at add-to-cart. (migration 0082) */
    min_purchase_qty: integer("min_purchase_qty"),
    max_purchase_qty: integer("max_purchase_qty"),

    /**
     * Variant stock mode for a `variable` product:
     *   NULL  — inherit the global default (app_secrets catalog.variant_stock_shared_default)
     *   true  — SHARED: all variants draw from this product's single stock_qty pool
     *           (per-variant stock_qty is ignored); used when per-variant counts
     *           aren't knowable ("10 in stock" = 10 across all variants).
     *   false — PER-VARIANT: each variant tracks its own stock_qty (the classic mode).
     * Only meaningful for variable products; ignored for simple ones.
     */
    shared_variant_stock: boolean("shared_variant_stock"),

    video_url: text("video_url"),
    /**
     * Video block presentation (all optional — sensible fallbacks at render):
     *   video_poster_media_id — soft-FK to media; thumbnail before play.
     *                           NULL → primary product image.
     *   video_title           — heading. NULL/empty → no heading rendered.
     *   video_description     — caption. NULL/empty → no caption rendered.
     */
    video_poster_media_id: text("video_poster_media_id"),
    video_title: text("video_title"),
    video_description: text("video_description"),

    /**
     * SEO / Référencement block — per-product search + social overrides.
     * All optional with sensible fallbacks resolved at render so an untouched
     * product still ships correct metadata:
     *   meta_title         — <title> + og:title. NULL → product name.
     *   meta_description   — meta description + og:description. NULL → short_desc.
     *   canonical_url      — rel=canonical override. NULL → `${SITE_URL}/${slug}`.
     *                        Use to point variant/duplicate SKUs at one master.
     *   noindex            — when true, emit robots `noindex,nofollow` (out-of-
     *                        catalogue / thin / staging products kept out of the
     *                        index without unpublishing them).
     *   og_image_media_id  — soft-FK to media; custom social-share card.
     *                        NULL → primary gallery image (compat variant).
     *   same_as            — newline-separated official external URLs for THIS
     *                        product (manufacturer / official store). Emitted as
     *                        schema.org Product.sameAs ONLY when the global
     *                        `seo.product_sameas_enabled` switch is on. NULL →
     *                        none. Parsed/validated by lib/seo/same-as.ts.
     */
    meta_title: text("meta_title"),
    meta_description: text("meta_description"),
    canonical_url: text("canonical_url"),
    noindex: boolean("noindex").notNull().default(false),
    og_image_media_id: text("og_image_media_id"),
    same_as: text("same_as"),

    display_order: integer("display_order").notNull().default(0),
    is_published: boolean("is_published").notNull().default(false),
    published_at: timestamp("published_at", { withTimezone: true }),
    /**
     * Global opt-out: when false this product NEVER receives any reduction
     * (auto-promotion, coupon, or coin redemption) — no matter what. Enforced
     * centrally in promotion.getActiveDiscountForProduct.
     */
    is_discountable: boolean("is_discountable").notNull().default(true),

    /** How the "Vous aimerez aussi" rail is populated (see PRODUCT_RELATED_MODES). */
    related_mode: text("related_mode").$type<ProductRelatedMode>().notNull().default("auto"),

    /**
     * Précommande (preorder) overlay. `is_preorder` is an admin toggle,
     * independent of `in_stock`, so a SKU can be sold before its stock arrives.
     * `preorder_releases_at` is when it ships / reverts to a normal sale — a past
     * date means it is no longer an ACTIVE preorder (see `@/lib/inventory/preorder`
     * `isActivePreorder`). `preorder_message` is optional free text shown on the
     * product page. `reserved_qty` is a CACHED count of the OPEN preorder
     * reservation units for this product's pool (SUM of active `stock_reservations`),
     * so `available = stock_qty − reserved_qty`. Maintained atomically by the
     * reservation service, exactly as `stock_qty` caches SUM(stock_levels.qty).
     */
    is_preorder: boolean("is_preorder").notNull().default(false),
    preorder_releases_at: timestamp("preorder_releases_at", { withTimezone: true }),
    preorder_message: text("preorder_message"),
    reserved_qty: integer("reserved_qty").notNull().default(0),

    ...timestamps(),
    ...softDelete(),
  },
  (table) => ({
    // Partial: a soft-deleted (tombstoned) row frees its slug for reuse,
    // matching checkSlugAvailability which filters `deleted_at IS NULL`.
    slugUnique: uniqueIndex("products_slug_unique")
      .on(table.slug)
      .where(sql`${table.deleted_at} is null`),
    // External-reference uniqueness over the live set (mirrors sku/gtin) — the
    // ERP linking key must map 1:1 to a live product. A tombstone frees the ref.
    externalRefUnique: uniqueIndex("products_external_ref_unique")
      .on(table.external_ref)
      .where(sql`${table.external_ref} is not null and ${table.deleted_at} is null`),
    // (products_published_idx dropped in 0087 — the non-partial ASC index was
    //  fully superseded by products_published_recent_idx (partial WHERE
    //  deleted_at IS NULL, published_at DESC), which every listing query matches;
    //  products_in_stock_idx / products_badge_idx dropped in 0084 — never queried
    //  on either column alone; the compound published/recent indexes serve those.)
    createdAtIdx: index("products_created_at_idx").on(table.created_at),
    // Admin lists ORDER BY (created_at DESC, id DESC) — composite matching the
    // sort direction + tiebreaker so deep pages scan index-only (migration 0107).
    createdIdDescIdx: index("products_created_id_desc_idx")
      .on(table.created_at.desc(), table.id.desc())
      .where(sql`${table.deleted_at} is null`),
    // Low-stock dashboard (admin `/admin`, every load): a partial index whose
    // predicate is IMPLIED by the `low` query (deleted_at IS NULL, in_stock = true,
    // stock_qty BETWEEN 1 AND N) so the planner can use it — it serves the
    // `ORDER BY stock_qty ASC` from the index, early-stopping via LIMIT (an index
    // range scan + a heap fetch for the ≤20 survivors; NOT index-only — name/slug/id
    // aren't in the leaf). Predicate deliberately OMITS is_published: the card mirrors
    // the stock page, which counts drafts too, so the query never filters it (a
    // predicate the query doesn't carry would make the index unusable). Stays small
    // (only live, in-stock, tracked rows). Migration 0122; predicate fixed in 0126.
    lowStockIdx: index("products_low_stock_idx")
      .on(table.stock_qty)
      .where(
        sql`${table.deleted_at} is null and ${table.in_stock} = true and ${table.stock_qty} is not null`,
      ),
    // products_sku_trgm (GIN gin_trgm_ops on sku, partial WHERE deleted_at IS
    // NULL) lives ONLY in migration 0107 — Drizzle can't express gin_trgm_ops.
    // It index-backs the admin search's `sku ILIKE '%term%'` branch (the name
    // branch already has products_name_trgm in the baseline).
    // Partial index over the preorder rows only — drives the
    // /admin/catalog/preorders queue + the storefront preorder rail. Tiny on disk
    // (is_preorder is rare).
    preorderIdx: index("products_preorder_idx")
      .on(table.preorder_releases_at)
      .where(sql`${table.is_preorder} = true`),
  }),
);

/**
 * Variants of a `variable` product. Each row is an independently-sellable
 * unit with its OWN absolute price / stock / identifiers / image. The parent
 * product's `price_cents` becomes the "à partir de" display price (min of
 * its variants); its `sku` is the parent SKU. `product_id` is uuid with a
 * real FK to products.id (ON DELETE CASCADE in the baseline). The attribute
 * combination that defines a variant lives in `product_variant_values`.
 */
export const product_variants = pgTable(
  "product_variants",
  {
    id: id(),
    product_id: uuid("product_id").notNull(),
    /** Child / variant SKU — unique per variant. */
    sku: text("sku"),
    gtin: text("gtin"),
    mpn: text("mpn"),
    /**
     * Denormalised human label of the attribute combination ("Rouge / 512 Go"),
     * computed + stored by the editor on save. Lets the cart / order / PDP show
     * the variant without resolving attribute metadata. Snapshot-ish: a later
     * attribute rename is picked up the next time variants are saved.
     */
    label: text("label").notNull().default(""),
    /** Absolute price of this variant (NOT a delta from the parent). */
    price_cents: integer("price_cents").notNull(),
    old_price_cents: integer("old_price_cents"),
    /** NULL = untracked stock (always sellable while `in_stock`). IGNORED in
     *  SHARED variant-stock mode — availability then comes from the parent
     *  `products.stock_qty` (see `products.shared_variant_stock`). */
    stock_qty: integer("stock_qty"),
    in_stock: boolean("in_stock").notNull().default(true),
    /** Optional variant-specific image; falls back to the product gallery. */
    image_media_id: text("image_media_id"),
    display_order: integer("display_order").notNull().default(0),
    /** The variant pre-selected on the PDP. Exactly one per product ideally. */
    is_default: boolean("is_default").notNull().default(false),
    /** CACHED count of OPEN preorder reservation units for this variant (SUM of
     *  active `stock_reservations`), so `available = stock_qty − reserved_qty`. */
    reserved_qty: integer("reserved_qty").notNull().default(0),
    ...timestamps(),
    ...softDelete(),
  },
  (table) => ({
    // (product_variants_product_idx (product_id) dropped in 0126 — a leading-column
    //  prefix of orderIdx (product_id, display_order), which serves the "variants of
    //  this product" reads + the product_id FK cascade on its own.)
    orderIdx: index("product_variants_order_idx").on(table.product_id, table.display_order),
    // Partial index over the LIVE set backing the PDP/admin variant ordering.
    liveOrderIdx: index("product_variants_live_order_idx")
      .on(table.product_id, table.display_order)
      .where(sql`${table.deleted_at} is null`),
    // Per-variant image lookup + media orphan-GC (partial: only rows that set one).
    imageMediaIdx: index("product_variants_image_media_id_idx")
      .on(table.image_media_id)
      .where(sql`${table.image_media_id} is not null`),
    // At most one default variant per product. Partial so non-defaults +
    // soft-deleted rows don't collide.
    oneDefaultPerProduct: uniqueIndex("product_variants_one_default_per_product")
      .on(table.product_id)
      .where(sql`${table.is_default} and ${table.deleted_at} is null`),
    // Child SKU / GTIN unique over LIVE rows only (migration 0008).
    // `findVariantBySku` uses skuUnique — the plain non-partial sku index was
    // redundant write-amplification and is dropped in migration 0030. Declared
    // here to keep schema.ts an accurate source of truth for these indexes.
    // NOTE: migrations are hand-authored and the drizzle meta snapshots are
    // intentionally frozen (they stop at 0007), so `drizzle-kit generate` must
    // NOT be run — it would diff against the stale snapshot and emit a
    // destructive migration. These declarations are documentation + parity, not
    // a generate-safety guarantee.
    skuUnique: uniqueIndex("product_variants_sku_unique")
      .on(table.sku)
      .where(sql`${table.sku} is not null and ${table.deleted_at} is null`),
    gtinUnique: uniqueIndex("product_variants_gtin_unique")
      .on(table.gtin)
      .where(sql`${table.gtin} is not null and ${table.deleted_at} is null`),
  }),
);

/**
 * Which attribute values define a variant — one row per (variant, value).
 * A "Rouge / 512 Go" variant links to the "Rouge" value AND the "512 Go"
 * value. Both columns carry real CASCADE FKs in the baseline
 * (variant_id → product_variants, attribute_value_id →
 * product_attribute_values).
 */
export const product_variant_values = pgTable(
  "product_variant_values",
  {
    id: id(),
    variant_id: uuid("variant_id").notNull(),
    attribute_value_id: uuid("attribute_value_id").notNull(),
    ...timestamps(),
  },
  (table) => ({
    variantIdx: index("product_variant_values_variant_idx").on(table.variant_id),
    valueIdx: index("product_variant_values_value_idx").on(table.attribute_value_id),
    uniq: uniqueIndex("product_variant_values_unique").on(
      table.variant_id,
      table.attribute_value_id,
    ),
  }),
);

export type ProductRow = typeof products.$inferSelect;
export type NewProductRow = typeof products.$inferInsert;
export type ProductVariantRow = typeof product_variants.$inferSelect;
export type NewProductVariantRow = typeof product_variants.$inferInsert;
export type ProductVariantValueRow = typeof product_variant_values.$inferSelect;
