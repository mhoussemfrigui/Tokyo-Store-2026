/**
 * PURE search-alias expansion — no `server-only`, no DB, so the whole matcher is
 * unit-testable (mirrors parse-config.ts). The async loader + CRUD live in
 * `service.ts`; the readers consume the `string[]` this returns.
 *
 * WHY app-layer query expansion (not a Postgres synonym/thesaurus dictionary):
 * those are configured from files in $SHAREDIR/tsearch_data — untouchable on a
 * managed/Coolify host without a container rebuild, single-token only, and every
 * change reindexes every tsvector. Rewriting the query instead is fully runtime-
 * editable, multi-word, needs no reindex, and the expanded tsquery still rides the
 * FTS GIN index (the reader ORs `websearch_to_tsquery(expansion)` into `q`).
 *
 * A rule is DIRECTIONAL: `term → expansion` means "when the shopper's query
 * contains TERM, ALSO search it with TERM replaced by EXPANSION". Matching is
 * TOKEN-level (word boundaries), so a single `chrono → chronographe` rule covers
 * « chrono acier », « montre chrono »… — never a substring false-hit. Both `term`
 * and `expansion` are already normalized (lowercased, unaccented, whitespace-
 * collapsed), exactly like the query passed in, so the comparison is like-for-like.
 */

export type SearchAlias = { term: string; expansion: string };

/**
 * Hard cap on the number of expansion VARIANTS OR-ed into a single search. Keeps
 * the tsquery bounded no matter how many rules an operator adds — the FTS GIN
 * BitmapOr stays cheap, and a pathological alias set can't balloon one query.
 */
export const MAX_QUERY_EXPANSIONS = 8;

/** Split a normalized query/phrase into word tokens (already single-spaced). */
function tokenize(s: string): string[] {
  return s.split(" ").filter(Boolean);
}

/**
 * Replace EVERY contiguous run of `needle` tokens in `hay` with `repl` tokens.
 * Returns the rewritten token list, or null when `needle` never occurs. Non-
 * overlapping, left-to-right; a multi-token needle only matches a full run.
 */
function replaceRun(hay: string[], needle: string[], repl: string[]): string[] | null {
  if (needle.length === 0 || needle.length > hay.length) return null;
  const out: string[] = [];
  let i = 0;
  let found = false;
  while (i < hay.length) {
    let match = i + needle.length <= hay.length;
    for (let j = 0; match && j < needle.length; j++) {
      if (hay[i + j] !== needle[j]) match = false;
    }
    if (match) {
      out.push(...repl);
      i += needle.length;
      found = true;
    } else {
      out.push(hay[i]);
      i += 1;
    }
  }
  return found ? out : null;
}

/**
 * Given a NORMALIZED query and the active alias rules, return the extra query
 * variants to OR into the search (the raw query itself is always run by the
 * reader, so it is NOT included here). Deterministic: rules are tried
 * longest-term-first (more specific wins the cap), then alphabetically. One pass
 * over the RAW query only — never recursive, so aliases can't chain-explode.
 */
export function expandSearchQuery(normalizedQuery: string, aliases: SearchAlias[]): string[] {
  const q = normalizedQuery.trim();
  if (!q) return [];
  const qTokens = tokenize(q);

  // Longest term first so a multi-word rule beats a bare one-word rule for the
  // cap, then stable by term/expansion text.
  const ordered = [...aliases].sort(
    (a, b) =>
      b.term.length - a.term.length ||
      a.term.localeCompare(b.term) ||
      a.expansion.localeCompare(b.expansion),
  );

  const variants: string[] = [];
  const seen = new Set<string>([q]); // never re-emit the raw query
  for (const a of ordered) {
    if (variants.length >= MAX_QUERY_EXPANSIONS) break;
    const term = a.term.trim();
    const expansion = a.expansion.trim();
    if (!term || !expansion || term === expansion) continue;
    const replaced = replaceRun(qTokens, tokenize(term), tokenize(expansion));
    if (!replaced) continue;
    const variant = replaced.join(" ");
    if (seen.has(variant)) continue;
    seen.add(variant);
    variants.push(variant);
  }
  return variants;
}
