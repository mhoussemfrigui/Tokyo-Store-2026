import { boolean, index, integer, jsonb, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

import { id, softDelete, timestamps } from "@/lib/db/columns";
import type { CategoryValueProp } from "@/modules/catalog/_shared/types";

export type { CategoryValueProp };

/**
 * Category — supports unlimited nesting via the self-referencing
 * `parent_id` (uuid, real FK in the baseline: ON DELETE SET NULL, so
 * deleting a parent promotes its children to roots). Subcategories are
 * just categories with a parent_id.
 *
 * Hero image is a soft link to the media module.
 *
 * Slugs are unique within siblings (i.e. unique on `parent_id` + `slug`),
 * but Postgres can't express that as a single unique index trivially with
 * NULL parent — we enforce in the workflow + add a partial unique for the
 * NULL-parent case.
 */
export const categories = pgTable(
  "categories",
  {
    id: id(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    tagline: text("tagline"),
    description: text("description"),
    parent_id: uuid("parent_id"),
    /**
     * External reference — a stable, opaque code from an EXTERNAL system (ERP /
     * PIM / marketplace) used to link & sync this category by reference over the
     * API. Unique among LIVE categories (partial index below); distinct from the
     * slug so the ERP key can diverge from the public URL. Empty → NULL.
     */
    external_ref: text("external_ref"),
    display_order: integer("display_order").notNull().default(0),
    meta_title: text("meta_title"),
    meta_description: text("meta_description"),
    /** Canonical override (folds duplicate / faceted URLs onto one master). */
    canonical_url: text("canonical_url"),
    /** Keep a still-active category out of search results without deactivating it. */
    noindex: boolean("noindex").notNull().default(false),
    /** Per-category social / OG image (soft link to media). */
    og_image_media_id: text("og_image_media_id"),
    /**
     * Category-level warranty (middle of the global → category → product
     * cascade). NULL `warranty_months` = inherit the global default; products
     * in this category inherit unless they set their own.
     */
    warranty_months: integer("warranty_months"),
    warranty_label: text("warranty_label"),
    /** TVA rate override (bps). NULL = inherit the global default. */
    tax_rate_bps: integer("tax_rate_bps"),
    /** Soft link to media row (the category PAGE's wide hero banner). */
    hero_media_id: text("hero_media_id"),
    /**
     * SEPARATE image for the /boutique chooser card (soft link to media) — kept
     * distinct from `hero_media_id` so the boutique landing tile and the
     * category page hero can differ. No render fallback to the hero: unset ⇒ the
     * card shows a soft gradient. (0131)
     */
    boutique_image_media_id: text("boutique_image_media_id"),
    /**
     * Editable listing chip-icon (storefront "thumbs" strip / CategoryNavBar).
     * `icon` is a curated lucide key (see @/lib/catalog/chip-icons); when null
     * the per-type default is used. `icon_media_id` is an OPTIONAL custom image
     * (soft link to media) that WINS over the icon key at render. (0105)
     */
    icon: text("icon"),
    icon_media_id: text("icon_media_id"),
    is_active: boolean("is_active").notNull().default(true),
    /** Global opt-out: products in this category never receive any reduction. */
    is_discountable: boolean("is_discountable").notNull().default(true),

    /**
     * Editorial block — admin-controllable copy for the category page
     * ("L'univers X" hero section). All nullable; the renderer falls back
     * to sensible defaults when blank so partially-edited categories still
     * look intentional.
     */
    editorial_eyebrow: text("editorial_eyebrow"),
    editorial_title: text("editorial_title"),
    editorial_body: text("editorial_body"),
    /** JSONB list of value-prop cards. See CategoryValueProp. */
    value_props: jsonb("value_props").$type<CategoryValueProp[]>(),

    ...timestamps(),
    ...softDelete(),
  },
  (table) => ({
    slugIdx: index("categories_slug_idx").on(table.slug),
    // Composite (parent_id, display_order) serves every sibling read — listChildren
    // (filter by parent + order), reorderSiblings' locked SELECT, and the recursive
    // subtree CTE's parent_id join — in index order. Its parent_id prefix also
    // covers the plain parent lookups the dropped standalone `categories_parent_idx`
    // did; the standalone `categories_display_order_idx` was never selective. (0137)
    parentDisplayOrderIdx: index("categories_parent_display_order_idx").on(
      table.parent_id,
      table.display_order,
    ),
    // Partial: uniqueness is enforced among LIVE ROOT categories only (siblings),
    // so a sub-category may reuse a root's slug AND a soft-deleted (archived) root
    // frees its slug — matching checkSlugAvailability + the external_ref index.
    // `slugIdx` above still indexes every slug for lookups.
    rootSlugUnique: uniqueIndex("categories_root_slug_unique")
      .on(table.slug)
      .where(sql`${table.parent_id} is null and ${table.deleted_at} is null`),
    // ERP linkage: unique among LIVE categories (partial, mirrors
    // products_external_ref_unique). NULL external_ref never collides.
    externalRefUnique: uniqueIndex("categories_external_ref_unique")
      .on(table.external_ref)
      .where(sql`${table.external_ref} is not null and ${table.deleted_at} is null`),
    // OG image soft-link index (parity with hero + products/pages og images),
    // keeps the media orphan reverse-lookup index-only.
    ogImageMediaIdIdx: index("categories_og_image_media_id_idx")
      .on(table.og_image_media_id)
      .where(sql`${table.og_image_media_id} is not null`),
    // Chip-icon soft-link index (0110) — media orphan reverse-lookup ORs
    // icon_media_id; keep that branch index-only like hero/og_image above.
    iconMediaIdIdx: index("categories_icon_media_id_idx")
      .on(table.icon_media_id)
      .where(sql`${table.icon_media_id} is not null`),
  }),
);

export type CategoryRow = typeof categories.$inferSelect;
export type NewCategoryRow = typeof categories.$inferInsert;

/**
 * Structural projection of a category row — everything the tree / sitemap /
 * mega-menu builders need, WITHOUT the heavy long-text + jsonb columns
 * (`description`, the editorial block, `value_props`, the meta fields). Loading
 * the whole table to build a ~structure-only tree previously dragged all of that
 * per row for no reader; `categoryService.listAllSlim()` selects just these.
 */
export type CategorySlimRow = Omit<
  CategoryRow,
  | "description"
  | "editorial_eyebrow"
  | "editorial_title"
  | "editorial_body"
  | "value_props"
  | "meta_title"
  | "meta_description"
  | "warranty_label"
>;
