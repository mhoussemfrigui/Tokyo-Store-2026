import {
  boolean,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

import { id, softDelete, timestamps } from "@/lib/db/columns";

/**
 * Banners module.
 *
 * `placement` discriminates where a banner shows up (home hero carousel,
 * header strip, in-grid promo cards, footer). Scheduling via start/end
 * dates lets admins prep campaigns in advance.
 */

export const bannerPlacementEnum = pgEnum("banner_placement", [
  "home_hero",
  "header_strip",
  "category_grid",
  "footer",
  // DEPRECATED: no storefront consumer renders a "checkout" banner. Removed
  // from the admin placement dropdown; kept here only for existing rows.
  "checkout",
  // LEGACY mega-menu featured-image placements (one per top-level nav dropdown).
  // Since the composable Nav Menu rebuild, dropdown imagery lives in
  // `nav_items.config` image blocks (edited in CMS → Nav Menu), materialized once
  // at boot (header-nav-roots.ts) from any pre-existing nav_* banner. NO storefront
  // consumer reads a nav_* banner and no admin UI creates one; these enum values
  // are kept only for those pre-migration rows + the dormant setNavFeaturedWorkflow.
  // `nav_collection` + `nav_fidelite` belonged to the removed Collections / Fidélité
  // nav sections — retained ONLY as legacy DB enum labels (no label map, workflow
  // or UI offers them); Postgres can't cleanly drop an enum value in place.
  "nav_boutique",
  "nav_marques",
  "nav_collection",
  "nav_fidelite",
  "nav_maison",
]);

export const banners = pgTable(
  "banners",
  {
    id: id(),
    placement: bannerPlacementEnum("placement").notNull(),
    name: text("name").notNull(),
    eyebrow: text("eyebrow"),
    title: text("title").notNull(),
    subtitle: text("subtitle"),
    description: text("description"),
    cta_label: text("cta_label"),
    cta_href: text("cta_href"),
    secondary_cta_label: text("secondary_cta_label"),
    secondary_cta_href: text("secondary_cta_href"),
    image_media_id: text("image_media_id"),
    // Optional art-directed MOBILE visual (portrait crop). When set, storefront
    // renderers swap to it under the mobile breakpoint via <picture>; when null
    // the desktop `image_media_id` is used at every width. Migration 0174.
    image_mobile_media_id: text("image_mobile_media_id"),
    // Optional HOSTED video URL for the home hero — plays muted/looped with
    // image_media_id as the poster/fallback. A plain external URL (sanitised on
    // read), NOT a média id: the médiathèque pipeline is image-only. Migration 0177.
    video_url: text("video_url"),
    // home_hero: false = a pure image/video LINK (no text/button overlay). 0177.
    show_text: boolean("show_text").notNull().default(true),
    // JSON array of editable CTAs [{label, href, variant}] — supersedes the legacy
    // cta_* / secondary_cta_* columns (migrated into it on read). NULL = legacy. 0177.
    buttons: text("buttons"),
    start_at: timestamp("start_at", { withTimezone: true }),
    end_at: timestamp("end_at", { withTimezone: true }),
    display_order: integer("display_order").notNull().default(0),
    is_active: boolean("is_active").notNull().default(true),
    // In-grid (category_grid) targeting + cadence — migration 0062.
    // `target_kind`: 'none' (global) | 'category' | 'brand' | 'filter'. DB CHECK
    // banners_target_kind_chk (db:generate frozen at 0007) enforces the set.
    // `target_ref`: target category/brand slug, or filter attribute id.
    // `after_load_more_count`: appear after every N "Charger plus" blocks.
    target_kind: text("target_kind").notNull().default("none"),
    target_ref: text("target_ref"),
    after_load_more_count: integer("after_load_more_count").notNull().default(2),
    // category_grid position: 'top' (above the listing) | 'after_load_more' (at the first
    // block boundary only) | 'after_rows' (every N blocks, N = after_load_more_count — the
    // legacy cadence). DB CHECK banners_grid_position_chk. Migration 0177.
    grid_position: text("grid_position").notNull().default("after_rows"),
    // header_strip style: background tone (olive|dark|gold|burgundy, CHECK), an optional
    // leading emoji/glyph, and a live countdown to end_at. Migration 0177.
    strip_tone: text("strip_tone").notNull().default("olive"),
    strip_icon: text("strip_icon"),
    show_countdown: boolean("show_countdown").notNull().default(false),
    ...timestamps(),
    ...softDelete(),
  },
  (table) => ({
    placementIdx: index("banners_placement_idx").on(table.placement),
    targetIdx: index("banners_target_idx").on(table.target_kind, table.target_ref),
    // NOTE: the live-read index `banners_live_placement_order_idx` (placement, display_order)
    // WHERE is_active AND deleted_at IS NULL, the scheduling index, and the media-id reverse-
    // lookup partials (image/image_mobile) all live in the raw migrations (0000/0174) only, not
    // here — matching the existing convention. The redundant single-column `banners_active_idx`
    // + `banners_order_idx` were pruned in migration 0178 (no query used them as a leading
    // column). video_url is a plain URL (no média FK), so it needs no index.
  }),
);

// In-grid banner targeting scope is the literal set `none|category|brand|filter`,
// enforced by the DB CHECK `banners_target_kind_chk` (migration 0062) and the
// workflow zod enum (createBannerSchema) — the single validation sources. No
// standalone TS union is kept here (it had no consumers and would just duplicate
// the enum).

export type BannerRow = typeof banners.$inferSelect;
export type NewBannerRow = typeof banners.$inferInsert;
export type BannerPlacement = (typeof bannerPlacementEnum.enumValues)[number];
