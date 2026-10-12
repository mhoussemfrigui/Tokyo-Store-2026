import { boolean, integer, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

import { id, timestamps } from "@/lib/db/columns";

/**
 * Admin-managed URL redirects (Système → Redirections & 404). One row per old
 * source path; the storefront `[slug]` / `[slug]/[sub]` pages resolve the
 * current path against this table (point lookup on the unique `source_path`
 * index) and issue a permanent (301/308) or temporary (302/307) redirect before
 * rendering — so retired / migrated URLs send visitors + crawlers to the new
 * location instead of 404ing.
 *
 * `source_path` is stored normalized (leading slash, no trailing slash, no
 * query) by lib/redirects/normalize.ts so lookups are exact. `destination` is a
 * site path or an absolute http(s) URL. Status codes are validated to the set
 * below. `hits` / `last_hit_at` are bumped fire-and-forget on each resolve.
 */
export const REDIRECT_STATUS_CODES = [301, 302, 307, 308] as const;
export type RedirectStatusCode = (typeof REDIRECT_STATUS_CODES)[number];

export const redirects = pgTable(
  "redirects",
  {
    id: id(),
    source_path: text("source_path").notNull(),
    destination: text("destination").notNull(),
    status_code: integer("status_code").notNull().default(301),
    is_active: boolean("is_active").notNull().default(true),
    notes: text("notes"),
    hits: integer("hits").notNull().default(0),
    last_hit_at: timestamp("last_hit_at", { withTimezone: true }),
    ...timestamps(),
  },
  (t) => ({
    // Serves the per-request point lookup `WHERE source_path = $1` AND enforces
    // one redirect per source path (CSV import upserts on it).
    sourceUnique: uniqueIndex("redirects_source_unique").on(t.source_path),
  }),
);

export type RedirectRow = typeof redirects.$inferSelect;
