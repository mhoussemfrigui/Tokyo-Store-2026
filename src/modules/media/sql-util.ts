/**
 * Shared SQL helpers for the media module.
 *
 * Deliberately framework-free (no `server-only`, no drizzle) so it can be
 * imported from both the server-only query/service layers and unit tests.
 */

/**
 * Escape LIKE/ILIKE metacharacters (`\`, `%`, `_`) so a value is matched
 * LITERALLY instead of being treated as a wildcard pattern — e.g. a filename
 * search for "a_b" or "50%", or a storage-key base reference lookup. Postgres
 * honours backslash escapes in (I)LIKE by default. Single-sourced here so the
 * media module's two callers (service.ts filename search + queries.ts
 * storage-key match) can never silently diverge on a future metacharacter fix.
 */
export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}
