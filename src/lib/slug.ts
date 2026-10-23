import { z } from "zod";

/**
 * Slug normaliser — ISOMORPHIC (no server-only) so the admin client-side
 * preview and the server-stored value share ONE algorithm and can never
 * disagree. Re-exported by src/workflows/helpers.ts for server callers.
 *
 *   "Xiaomi Redmi Note 13 Pro (256 Go!)" → "xiaomi-redmi-note-13-pro-256-go"
 *
 * Conservative — won't touch already-clean strings.
 */
export function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // strip diacritics
    .replace(/[^a-z0-9]+/g, "-")
    // Slice to the length cap BEFORE stripping edge hyphens — otherwise a
    // truncation that lands on a separator leaves a trailing "-", producing a
    // slug that this file's own `slugSchema` (must end alphanumeric) rejects on
    // save. Order matters: collapse → cap → trim edges.
    .slice(0, 80)
    .replace(/^-+|-+$/g, "");
}

export const slugSchema = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "Slug invalide");
