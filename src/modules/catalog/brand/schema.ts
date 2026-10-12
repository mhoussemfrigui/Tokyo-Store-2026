import { boolean, index, integer, jsonb, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
// NOTE: brands are FLAT (no parent). display_order gives a single global manual
// ordering for /marques + the nav strip; no parent-scoped composite index (a pure
// sort index is not selective at brand-table scale — see migration 0138).
import { sql } from "drizzle-orm";

import { id, softDelete, timestamps } from "@/lib/db/columns";

import type { CategoryValueProp } from "@/modules/catalog/_shared/types";

/**
 * Brand — owns its own table. Product references brand_id via the
 * `product-brand` association, not a direct FK.
 */
export const brands = pgTable(
  "brands",
  {
    id: id(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    /**
     * External reference — a stable, opaque code from an EXTERNAL system (ERP /
     * PIM / marketplace) for linking & syncing this brand by reference over the
     * API. Unique among LIVE brands (partial index below). Empty → NULL.
     */
    external_ref: text("external_ref"),
    /** Optional logo — soft link to a media row. */
    logo_media_id: text("logo_media_id"),
    /**
     * Editable listing chip-icon (storefront "thumbs" strip / CategoryNavBar).
     * `icon` is a curated lucide key (see @/lib/catalog/chip-icons); when null
     * the per-type default is used. `icon_media_id` is an OPTIONAL custom image
     * (soft link to media) that WINS over the icon key at render. (0105)
     */
    icon: text("icon"),
    icon_media_id: text("icon_media_id"),
    is_active: boolean("is_active").notNull().default(true),
    /**
     * Manual display order (0-based) for the flat brand list — /marques index,
     * the storefront "Marques" nav strip, the admin list + reorder. Lower = first;
     * ties fall back to name. Backfilled from the alphabetical order in 0138. (0138)
     */
    display_order: integer("display_order").notNull().default(0),
    /** Global opt-out: products of this brand never receive any reduction — the
     *  brand tier of the discount opt-out (mirrors categories.is_discountable). (0138) */
    is_discountable: boolean("is_discountable").notNull().default(true),

    /**
     * Per-brand TVA rate in basis points (1900 = 19 %). NULL = inherit the
     * category/global rate. Sits between the filter tier and the category tier
     * in the tax cascade (product → filter → brand → category → global). (0049)
     * DB + Zod both guard the 0–10000 range (brands_tax_rate_bps_range, 0138).
     */
    tax_rate_bps: integer("tax_rate_bps"),

    /**
     * Editorial block — admin-controllable copy for the brand landing page
     * (served at the flat /<slug> route; /brand/<slug> permanently redirects
     * there). All nullable and HIDE-WHEN-UNSET: an empty field renders nothing,
     * and the whole editorial / FAQ section is omitted when empty (no fabricated
     * defaults). See CategoryEditorial.
     */
    hero_media_id: text("hero_media_id"),
    tagline: text("tagline"),
    editorial_eyebrow: text("editorial_eyebrow"),
    editorial_title: text("editorial_title"),
    editorial_body: text("editorial_body"),
    /** JSONB list of value-prop cards. See CategoryValueProp. */
    value_props: jsonb("value_props").$type<CategoryValueProp[]>(),
    meta_title: text("meta_title"),
    meta_description: text("meta_description"),
    /** Canonical override (folds duplicate URLs onto one master). */
    canonical_url: text("canonical_url"),
    /** Keep a still-active brand out of search results without deactivating it. */
    noindex: boolean("noindex").notNull().default(false),
    /** Per-brand social / OG image (soft link to media). */
    og_image_media_id: text("og_image_media_id"),

    ...timestamps(),
    ...softDelete(),
  },
  (table) => ({
    // Partial: tombstoned (soft-deleted) brands free their slug for reuse.
    slugUnique: uniqueIndex("brands_slug_unique")
      .on(table.slug)
      .where(sql`${table.deleted_at} is null`),
    // ERP linkage: unique among LIVE brands (partial, mirrors
    // categories_external_ref_unique). NULL external_ref never collides.
    externalRefUnique: uniqueIndex("brands_external_ref_unique")
      .on(table.external_ref)
      .where(sql`${table.external_ref} is not null and ${table.deleted_at} is null`),
    // OG image soft-link index (parity with logo/hero + categories OG); keeps
    // the media orphan reverse-lookup index-only.
    ogImageMediaIdIdx: index("brands_og_image_media_id_idx")
      .on(table.og_image_media_id)
      .where(sql`${table.og_image_media_id} is not null`),
    // Chip-icon soft-link index (0110) — the media orphan reverse-lookup now
    // ORs icon_media_id too, so keep that branch index-only like the others.
    iconMediaIdIdx: index("brands_icon_media_id_idx")
      .on(table.icon_media_id)
      .where(sql`${table.icon_media_id} is not null`),
  }),
);

export type BrandRow = typeof brands.$inferSelect;
export type NewBrandRow = typeof brands.$inferInsert;
