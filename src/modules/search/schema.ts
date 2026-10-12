import { boolean, index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * Search module.
 *
 * The only *table* this module owns is `search_log` — an append-only
 * record of every storefront search query. The actual searchable
 * `search_vector` columns live on the modules whose content they index
 * (products, blog_posts, categories, brands, pages) as
 * generated tsvector columns created in the baseline migration. That
 * keeps the schema graph honest: the data lives where it conceptually
 * belongs.
 *
 * Why log searches?
 *   • Drive editorial decisions ("everyone is searching for 'montre
 *     connectée' but we don't carry one — add a category").
 *   • Surface synonyms gaps (top zero-result queries become candidates
 *     for synonym dictionaries or redirect rules).
 *   • Health metric: average results per query over time.
 *
 * Privacy
 * ───────
 * `user_id` and `ip` are nullable; we record them when present but the
 * admin UI never surfaces ip. Retention is admin-configurable via
 * `search.purge_months` (Recherche → Réglages/Purge, default 3 months ≈ 90d),
 * resolved at purge time in `runRetentionPurge` and applied via
 * `searchService.purgeOlderThan` (the /api/cron/retention sweep + the admin
 * "Run now"); the 90-day `RETENTION_WINDOWS.search_log` is only the
 * settings-read-failure fallback. The BRIN on created_at keeps the sweep cheap.
 */
export const search_log = pgTable(
  "search_log",
  {
    // uuid v7 (time-ordered) for better index locality on this hot
    // append-only table.
    id: uuid("id").primaryKey().default(sql`uuid_generate_v7()`),
    /** Raw user input — preserved for spotting attacks / quirks. */
    query: text("query").notNull(),
    /** Lowercased, accent-stripped, whitespace-collapsed form for GROUP BY. */
    normalized_query: text("normalized_query").notNull(),
    /** How many hits the search produced (0 = candidate for synonym work). */
    result_count: integer("result_count").notNull().default(0),
    /** Soft link to users.id (no FK — cross-module). */
    user_id: text("user_id"),
    /** Client IP. Never shown in admin UI. */
    ip: text("ip"),
    created_at: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (table) => ({
    // Two more indexes live only in the baseline SQL because Drizzle
    // can't express them: a partial idx on zero-result rows
    // (search_log_zero_result_idx) and a BRIN on created_at
    // (search_log_created_at_brin).
    normalizedIdx: index("search_log_normalized_idx").on(
      table.normalized_query,
      table.created_at.desc(),
    ),
  }),
);

export type SearchLogRow = typeof search_log.$inferSelect;
export type NewSearchLogRow = typeof search_log.$inferInsert;

/**
 * Search aliases / synonyms (migration 0114) — runtime-editable, DIRECTIONAL
 * `term → expansion` query-expansion rules. When a shopper's (normalized) query
 * contains `term`, the reader ALSO searches it with `term` replaced by
 * `expansion` (OR-ed into the FTS tsquery — widens recall, never rewrites the raw
 * query's own scoring). Both columns are stored ALREADY-NORMALIZED (lowercase,
 * unaccented, single-spaced) so they match the folded query. `source`
 * distinguishes operator rules ('manual') from the catalogue default seed
 * ('default'), so "reload defaults" re-merges without clobbering manual edits.
 * Expansion logic is pure (aliases.ts); the CRUD + TTL-cached loader live in
 * service.ts.
 */
export const search_aliases = pgTable(
  "search_aliases",
  {
    id: uuid("id").primaryKey().default(sql`uuid_generate_v7()`),
    /** Normalized trigger phrase (what the shopper types). */
    term: text("term").notNull(),
    /** Normalized canonical phrase to ALSO search for. */
    expansion: text("expansion").notNull(),
    is_active: boolean("is_active").notNull().default(true),
    /** 'manual' (operator) | 'default' (catalogue seed). */
    source: text("source").$type<"manual" | "default">().notNull().default("manual"),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`),
    updated_at: timestamp("updated_at", { withTimezone: true }).notNull().default(sql`now()`),
  },
  (table) => ({
    termExpansionUniq: uniqueIndex("search_aliases_term_expansion_uniq").on(
      table.term,
      table.expansion,
    ),
    // Partial index over ACTIVE rules — the storefront loader only reads active ones.
    activeIdx: index("search_aliases_active_idx")
      .on(table.term)
      .where(sql`is_active = true`),
  }),
);

export type SearchAliasRow = typeof search_aliases.$inferSelect;
export type NewSearchAliasRow = typeof search_aliases.$inferInsert;
