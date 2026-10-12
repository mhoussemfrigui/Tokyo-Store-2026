/**
 * Upload-limit constants — the single source of truth for the default media
 * upload ceiling.
 *
 * Deliberately framework-free (no `server-only`, no drizzle imports) so BOTH
 * the server pipeline (`processor.ts`, server-only) and the client admin panel
 * (`media-panel.tsx`, "use client") can import the same number. The live
 * ceiling is settings-driven (`media_settings.max_upload_mb`, read via
 * `getMaxUploadBytes()`); this is the fallback used before the DB is consulted
 * and for early client-side UX feedback.
 *
 * `DEFAULT_MAX_UPLOAD_MB` also backs the `max_upload_mb` column default in
 * `settings.schema.ts`, so "8 MB" is defined in exactly one place.
 */
export const DEFAULT_MAX_UPLOAD_MB = 8;

export const MAX_UPLOAD_BYTES_FALLBACK = DEFAULT_MAX_UPLOAD_MB * 1024 * 1024;

/**
 * Hard ceiling for `max_upload_mb`, capped at the Next.js request-body limit
 * (`experimental.proxyClientMaxBodySize = "16mb"` in next.config.ts) — Next
 * truncates the body above that, so a higher setting is unachievable. Lives here
 * (framework-free) so the server clamp (settings.service) AND the client form
 * (`max=` on the input) share ONE value. Keep in sync with the next.config knob.
 */
export const MAX_UPLOAD_MB_CEILING = 16;

/**
 * Largest Médiathèque selection one bulk action accepts (the orphans view loads
 * 200). The server actions (`listMediaInUseAction` / `bulkDeleteMediaAction`)
 * refuse a longer list; the library grid can exceed it once « Charger plus »
 * has appended batches, so the panel checks the SAME number before opening the
 * bulk-delete confirm instead of letting the in-use lookup fail on it.
 */
export const BULK_MEDIA_MAX = 200;
