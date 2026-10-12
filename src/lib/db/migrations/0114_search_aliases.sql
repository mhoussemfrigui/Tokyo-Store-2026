-- 0114 — Search aliases / synonyms.
--
-- Runtime-editable query-expansion rules: a DIRECTIONAL `term → expansion` pair
-- ("chrono" → "chronographe", "diver" → "plongee") that widens FTS recall by
-- OR-ing websearch_to_tsquery(expansion) into the search tsquery. Chosen over a
-- Postgres synonym/thesaurus dictionary because that needs a container rebuild,
-- is single-token, and reindexes every tsvector on change — this is fully
-- admin-editable, multi-word, and needs no reindex. Both columns are stored
-- ALREADY-NORMALIZED (lowercase, unaccented, single-spaced) so they match the
-- folded query. `source` distinguishes operator rules ('manual') from the
-- catalogue default seed ('default') so "reload defaults" re-merges without
-- clobbering manual edits. Purely additive; no extension prerequisite
-- (uuid_generate_v7 already exists).

CREATE TABLE IF NOT EXISTS "search_aliases" (
  "id"         uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  "term"       text NOT NULL,
  "expansion"  text NOT NULL,
  "is_active"  boolean NOT NULL DEFAULT true,
  "source"     text NOT NULL DEFAULT 'manual',
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "search_aliases_term_expansion_uniq"
  ON "search_aliases" ("term", "expansion");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "search_aliases_active_idx"
  ON "search_aliases" ("term") WHERE "is_active" = true;
