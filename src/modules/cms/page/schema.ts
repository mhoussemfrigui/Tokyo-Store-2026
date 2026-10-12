import {
  boolean,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { id, softDelete, timestamps } from "@/lib/db/columns";

/**
 * Page storage — a JSON block layout, with the legacy relational sections kept
 * READ-ONLY for non-destructive rollover.
 *
 *   pages                 — one row per page (slug, meta, publish state) +
 *                           `blocks` (the JSON composer layout, migration 0175)
 *
 * The composer edits `pages.blocks` (an ordered [{id,type,visible,config}]
 * array, mirroring home.blocks). A page that predates the composer has a NULL
 * `blocks` column; `getPageForRender` / `getEditBlocks` then SYNTHESISE blocks
 * from the relational section tables below so it renders identically until an
 * operator saves in the composer (which writes `blocks` and never touches the
 * legacy rows). There is no section WRITE path any more — the tables exist only
 * so legacy pages keep rendering.
 *
 *   page_sections         — ordered list of sections per page (type discriminator)
 *     ↓
 *   hero_sections         — type=hero data (1:1 with page_sections row)
 *   text_sections         — type=text data
 *   cta_sections          — type=cta data
 *   stats_sections        — type=stats data + stats_section_items children
 *   timeline_sections     — type=timeline data + timeline_section_items children
 *
 * The dormant `product_list` / `banner_grid` enum values have no typed table and
 * are ignored on read.
 */

export const pages = pgTable(
  "pages",
  {
    id: id(),
    slug: text("slug").notNull(),
    title: text("title").notNull(),
    meta_title: text("meta_title"),
    meta_description: text("meta_description"),
    og_image_media_id: text("og_image_media_id"),
    is_published: boolean("is_published").notNull().default(false),
    published_at: timestamp("published_at", { withTimezone: true }),
    // System pages (help + legal) are seeded and protected: the admin can edit
    // their sections but not delete them. Added in migration 0060.
    is_system: boolean("is_system").notNull().default(false),
    // Instance-based block layout (JSON array of {id,type,visible,config}) — the
    // successor to page_sections, mirroring home.blocks. NULL/empty → the reader
    // synthesises blocks from page_sections (non-destructive). Migration 0175.
    blocks: text("blocks"),
    // Per-page SEO: an explicit canonical override (blank → own URL) and a noindex
    // flag to keep a thin/duplicate page out of search. Migration 0175.
    canonical_url: text("canonical_url"),
    noindex: boolean("noindex").notNull().default(false),
    ...timestamps(),
    ...softDelete(),
  },
  (table) => ({
    slugUnique: uniqueIndex("pages_slug_unique").on(table.slug),
    publishedIdx: index("pages_published_idx").on(table.is_published),
  }),
);

export const pageSectionTypeEnum = pgEnum("page_section_type", [
  "hero",
  "text",
  "cta",
  "stats",
  "timeline",
  "product_list",
  "banner_grid",
]);

export const page_sections = pgTable(
  "page_sections",
  {
    id: id(),
    // uuid — real FK to pages.id (ON DELETE CASCADE in the baseline).
    page_id: uuid("page_id").notNull(),
    type: pageSectionTypeEnum("type").notNull(),
    display_order: integer("display_order").notNull().default(0),
    is_visible: boolean("is_visible").notNull().default(true),
    ...timestamps(),
  },
  (table) => ({
    pageIdx: index("page_sections_page_idx").on(table.page_id),
    orderIdx: index("page_sections_order_idx").on(table.display_order),
  }),
);

// ──────────────────────────────────────────────────────── type-specific tables
// Every child section's `page_section_id` is a uuid PK with a real
// ON DELETE CASCADE FK to `page_sections.id` (baseline), so deleting a
// section row sweeps its subtype row too.
export const hero_sections = pgTable("hero_sections", {
  page_section_id: uuid("page_section_id").primaryKey(),
  eyebrow: text("eyebrow"),
  title: text("title").notNull(),
  subtitle: text("subtitle"),
  description: text("description"),
  image_media_id: text("image_media_id"),
  primary_cta_label: text("primary_cta_label"),
  primary_cta_href: text("primary_cta_href"),
  secondary_cta_label: text("secondary_cta_label"),
  secondary_cta_href: text("secondary_cta_href"),
});

export const text_sections = pgTable("text_sections", {
  page_section_id: uuid("page_section_id").primaryKey(),
  heading: text("heading"),
  body: text("body").notNull(), // HTML output from TipTap (sanitized on render)
  alignment: text("alignment").notNull().default("left"),
});

export const cta_sections = pgTable("cta_sections", {
  page_section_id: uuid("page_section_id").primaryKey(),
  title: text("title").notNull(),
  description: text("description"),
  primary_cta_label: text("primary_cta_label").notNull(),
  primary_cta_href: text("primary_cta_href").notNull(),
  background_image_media_id: text("background_image_media_id"),
  style: text("style").notNull().default("dark"),
});

export const stats_sections = pgTable("stats_sections", {
  page_section_id: uuid("page_section_id").primaryKey(),
  heading: text("heading"),
  layout: text("layout").notNull().default("grid"),
});

export const stats_section_items = pgTable(
  "stats_section_items",
  {
    id: id(),
    stats_section_id: uuid("stats_section_id").notNull(),
    label: text("label").notNull(),
    value: text("value").notNull(),
    caption: text("caption"),
    display_order: integer("display_order").notNull().default(0),
  },
  (table) => ({
    parentIdx: index("stats_items_parent_idx").on(table.stats_section_id),
  }),
);

export const timeline_sections = pgTable("timeline_sections", {
  page_section_id: uuid("page_section_id").primaryKey(),
  heading: text("heading"),
});

export const timeline_section_items = pgTable(
  "timeline_section_items",
  {
    id: id(),
    timeline_section_id: uuid("timeline_section_id").notNull(),
    year: text("year").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    display_order: integer("display_order").notNull().default(0),
  },
  (table) => ({
    parentIdx: index("timeline_items_parent_idx").on(table.timeline_section_id),
  }),
);

export type PageRow = typeof pages.$inferSelect;
export type NewPageRow = typeof pages.$inferInsert;
export type PageSectionRow = typeof page_sections.$inferSelect;
export type PageSectionType = (typeof pageSectionTypeEnum.enumValues)[number];
