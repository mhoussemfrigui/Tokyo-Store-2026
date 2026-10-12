import { boolean, integer, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

import { timestamps } from "@/lib/db/columns";
import { DEFAULT_MAX_UPLOAD_MB } from "./limits";

/**
 * Media processing settings — singleton config row.
 *
 * One row, always with `id = '00000000-0000-0000-0000-000000000001'`. A
 * CHECK constraint in the baseline (`media_settings_singleton`) rejects any
 * other id; the service always reads/writes the singleton via
 * `mediaSettingsService.get/update`.
 *
 * Each toggle is independently editable from `/admin/media/settings`:
 *
 *   - `generate_avif` / `generate_webp` — emit additional variants on upload
 *     so the storefront can pick the smallest format the browser supports
 *   - `keep_original` — preserve the source bytes alongside the variants
 *     (lets an admin re-process later if quality settings change)
 *   - `product_white_bg` — remove the UNIFORM studio backdrop from PRODUCT-scope
 *     uploads to transparent before variant generation (détourage). The column
 *     name is historical (frozen): the algorithm samples the border's median
 *     colour and flood-fills ANY flat sweep — white, black, grey, or a flat
 *     colour — from the image borders → alpha 0, while interior regions matching
 *     the backdrop (e.g. a white dial on a white sweep) survive. Non-packshot /
 *     textured / gradient backgrounds pass through unchanged. Off by default.
 *     WebP/AVIF keep the transparent cut-out; the JPEG fallback is flattened
 *     onto white.
 *   - `max_width_px` / `max_height_px` — two independent axis caps (`fit:"inside"`
 *     + `withoutEnlargement`, never a single longest-edge cap); 0 = no cap on
 *     that axis, and the resize step is skipped only when both are 0 / unexceeded
 *   - `*_quality` — sharp quality settings per encoder, clamped to 30–100 by the
 *     service/workflow (a near-zero quality yields an unreadable image)
 *   - `strip_exif` — remove camera metadata before storing
 *   - `max_upload_mb` — defence-in-depth ceiling beyond Next.js's body limit
 *
 * Defaults below are what a fresh database processes with until an admin
 * edits the row.
 */

export const SINGLETON_ID = "00000000-0000-0000-0000-000000000001";

export const media_settings = pgTable("media_settings", {
  id: uuid("id").primaryKey().default(sql`'${sql.raw(SINGLETON_ID)}'::uuid`),

  // Output format flags
  generate_webp: boolean("generate_webp").notNull().default(true),
  // AVIF on by default — it's the smallest modern format and the storefront
  // serves it as the primary "show" image (see media/url-resolver.ts).
  // Slower to encode than WebP, but a one-time per-upload cost.
  generate_avif: boolean("generate_avif").notNull().default(true),
  keep_original: boolean("keep_original").notNull().default(false),

  // Auto UNIFORM-backdrop REMOVAL for PRODUCT images (détourage). The column
  // name is frozen/historical — the algorithm generalised from white-only to
  // ANY uniform sweep. When enabled, product uploads have their connected studio
  // backdrop (white, black, grey, or a flat colour) cut out to transparent
  // BEFORE variant generation: the border's median colour is flood-filled from
  // the image borders → alpha 0, so a packshot's studio sweep is removed while
  // interior regions matching the backdrop (e.g. a white dial on a white sweep)
  // are preserved. Default FALSE → the pipeline behaves exactly as before out of
  // the box.
  //
  // SCOPE: this is an edge flood-fill removal (see white-bg.ts), not AI subject
  // segmentation — a photo on a TEXTURED / gradient / multi-coloured background
  // (border not uniform) is detected as non-packshot and returned unchanged. The
  // WebP/AVIF variants keep the transparent cut-out; the JPEG fallback is
  // flattened onto white.
  product_white_bg: boolean("product_white_bg").notNull().default(false),

  // Restrict auto-détourage to a product's MAIN image (its first gallery image)
  // instead of every product image. When ON, upload-time détourage is skipped and
  // only the main image is cut out at product SAVE (idempotent reprocess) — so
  // secondary/gallery shots keep their original backdrop. No-op unless
  // `product_white_bg` is also on. Default FALSE → détoure all product uploads.
  product_white_bg_main_only: boolean("product_white_bg_main_only").notNull().default(false),

  // Resize cap (px, 0 to disable)
  max_width_px: integer("max_width_px").notNull().default(2400),
  max_height_px: integer("max_height_px").notNull().default(2400),

  // Encoder quality (clamped to 30–100 by the service/workflow)
  webp_quality: integer("webp_quality").notNull().default(82),
  avif_quality: integer("avif_quality").notNull().default(60),
  jpeg_quality: integer("jpeg_quality").notNull().default(85),

  // Privacy / security
  strip_exif: boolean("strip_exif").notNull().default(true),
  // Default ceiling shared with the server fallback + client panel (see
  // ./limits). Resolves to the same literal in generated SQL — no migration.
  max_upload_mb: integer("max_upload_mb").notNull().default(DEFAULT_MAX_UPLOAD_MB),

  // Misc
  default_alt_text: text("default_alt_text"),
  cdn_base_url: text("cdn_base_url"), // optional override for the public URL prefix

  ...timestamps(),
});

export type MediaSettingsRow = typeof media_settings.$inferSelect;
