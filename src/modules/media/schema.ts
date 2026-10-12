import { sql } from "drizzle-orm";
import { bigint, index, integer, pgEnum, pgTable, text } from "drizzle-orm/pg-core";

import { id, softDelete, timestamps } from "@/lib/db/columns";

/**
 * Media module — `media` table.
 *
 * The full module shape lives next to this file:
 *   - storage.ts             : S3 client — SeaweedFS (PUT/DELETE; reads via the /cdn proxy)
 *   - processor.ts           : sharp pipeline (resize, EXIF strip, variants)
 *   - service.ts             : CRUD on `media`
 *   - queries.ts             : read-side helpers
 *   - settings.schema.ts     : `media_settings` singleton (runtime knobs)
 *   - settings.service.ts    : singleton get/update + in-process cache
 *   - index.ts               : public barrel
 *
 * Variant URLs (`webp_url`, `avif_url`, `original_url`) are populated by
 * the upload workflow per the live `media_settings` row. `url_override` is
 * an admin escape hatch for CDN migrations — when set, the storefront uses
 * it verbatim and skips variant resolution. See docs/media.md.
 *
 * `uploaded_by` stores a Better-Auth user id but is intentionally not a
 * hard FK (users.id is a text PK owned by the auth module). It is written on
 * every upload for provenance/audit but is NOT currently surfaced in any admin
 * view (reserved for a future "uploaded by" column); accounts are disabled
 * rather than deleted, so the id stays resolvable if a view is ever added.
 */

export const mediaKindEnum = pgEnum("media_kind", [
  "image",
  "video",
  "document",
  "other",
]);

export const media = pgTable(
  "media",
  {
    id: id(),
    kind: mediaKindEnum("kind").notNull().default("image"),
    storage_key: text("storage_key").notNull(), // path inside the bucket (e.g. "products/abc.jpg")
    url: text("url").notNull(), // canonical public URL — the quality-controlled JPEG primary by default, overridden by url_override
    filename: text("filename").notNull(),
    mime_type: text("mime_type").notNull(),
    size_bytes: bigint("size_bytes", { mode: "number" }).notNull(),
    width: integer("width"),
    height: integer("height"),
    alt_text: text("alt_text"),
    uploaded_by: text("uploaded_by"), // soft link to users.id (no FK — see header)

    // Variant tracking — populated by the upload workflow based on
    // media_settings. NULL means "this variant was not generated".
    webp_url: text("webp_url"),
    webp_size_bytes: bigint("webp_size_bytes", { mode: "number" }),
    avif_url: text("avif_url"),
    avif_size_bytes: bigint("avif_size_bytes", { mode: "number" }),
    original_url: text("original_url"),
    original_size_bytes: bigint("original_size_bytes", { mode: "number" }),
    original_mime_type: text("original_mime_type"),

    // Manual override — when set, storefront uses this verbatim and skips
    // variant resolution. Used when migrating to an external CDN.
    url_override: text("url_override"),

    ...timestamps(),
    ...softDelete(),
  },
  (table) => ({
    // Partial composite over the LIVE set — backs the keyset pagination
    // (orderBy created_at desc, id desc), the index-only live count(), and the
    // listOrphans ORDER BY, all of which filter `deleted_at IS NULL`. Replaces
    // the full single-column media_created_at_idx (migration 0029). The former
    // uploaded_by / kind indexes were write-only and the filename search is the
    // media_filename_trgm GIN index — both from migration 0028.
    liveIdx: index("media_live_idx")
      .on(table.created_at.desc(), table.id.desc())
      .where(sql`${table.deleted_at} is null`),
  }),
);

export type MediaRow = typeof media.$inferSelect;
export type NewMediaRow = typeof media.$inferInsert;
